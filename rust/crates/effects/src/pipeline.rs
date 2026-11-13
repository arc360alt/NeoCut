use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{EffectPass, UniformValue};

/// Where a named uniform goes in [`EffectUniformBuffer`].
#[derive(Clone, Copy)]
enum UniformSlot {
    /// `direction`, a 2-component vector.
    Direction,
    /// One component of `scalars`.
    Scalar(usize),
}

/// An effect shader and the uniforms it takes. Every listed uniform is
/// required; any other uniform is rejected.
struct ShaderSpec {
    id: &'static str,
    source: &'static str,
    uniforms: &'static [(&'static str, UniformSlot)],
}

const SHADERS: &[ShaderSpec] = &[
    ShaderSpec {
        id: "gaussian-blur",
        source: include_str!("shaders/gaussian_blur.wgsl"),
        uniforms: &[
            ("u_sigma", UniformSlot::Scalar(0)),
            ("u_step", UniformSlot::Scalar(1)),
            ("u_direction", UniformSlot::Direction),
        ],
    },
    ShaderSpec {
        id: "vignette",
        source: include_str!("shaders/vignette.wgsl"),
        uniforms: &[
            ("u_amount", UniformSlot::Scalar(0)),
            ("u_size", UniformSlot::Scalar(1)),
            ("u_softness", UniformSlot::Scalar(2)),
        ],
    },
    ShaderSpec {
        id: "pixelate",
        source: include_str!("shaders/pixelate.wgsl"),
        uniforms: &[("u_block_size", UniformSlot::Scalar(0))],
    },
    ShaderSpec {
        id: "rgb-split",
        source: include_str!("shaders/rgb_split.wgsl"),
        uniforms: &[
            ("u_distance", UniformSlot::Scalar(0)),
            ("u_direction", UniformSlot::Direction),
        ],
    },
    ShaderSpec {
        id: "sharpen",
        source: include_str!("shaders/sharpen.wgsl"),
        uniforms: &[("u_amount", UniformSlot::Scalar(0))],
    },
    ShaderSpec {
        id: "posterize",
        source: include_str!("shaders/posterize.wgsl"),
        uniforms: &[("u_levels", UniformSlot::Scalar(0))],
    },
    ShaderSpec {
        id: "wave",
        source: include_str!("shaders/wave.wgsl"),
        uniforms: &[
            ("u_amplitude", UniformSlot::Scalar(0)),
            ("u_frequency", UniformSlot::Scalar(1)),
            ("u_phase", UniformSlot::Scalar(2)),
        ],
    },
];

fn shader_spec(shader: &str) -> Option<&'static ShaderSpec> {
    SHADERS.iter().find(|spec| spec.id == shader)
}

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    direction: [f32; 2],
    scalars: [f32; 4],
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let pipeline_layout =
            context
                .device()
                .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("effects-pipeline-layout"),
                    bind_group_layouts: &[
                        Some(context.texture_sampler_bind_group_layout()),
                        Some(&uniform_bind_group_layout),
                    ],
                    immediate_size: 0,
                });
        let pipelines = SHADERS
            .iter()
            .map(|spec| {
                let fragment_module =
                    context
                        .device()
                        .create_shader_module(wgpu::ShaderModuleDescriptor {
                            label: Some(spec.id),
                            source: wgpu::ShaderSource::Wgsl(spec.source.into()),
                        });
                let pipeline =
                    context
                        .device()
                        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                            label: Some(spec.id),
                            layout: Some(&pipeline_layout),
                            vertex: wgpu::VertexState {
                                module: &vertex_shader_module,
                                entry_point: Some("vertex_main"),
                                buffers: &[wgpu::VertexBufferLayout {
                                    array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                                    step_mode: wgpu::VertexStepMode::Vertex,
                                    attributes: &[wgpu::VertexAttribute {
                                        format: wgpu::VertexFormat::Float32x2,
                                        offset: 0,
                                        shader_location: 0,
                                    }],
                                }],
                                compilation_options: wgpu::PipelineCompilationOptions::default(),
                            },
                            fragment: Some(wgpu::FragmentState {
                                module: &fragment_module,
                                entry_point: Some("fragment_main"),
                                targets: &[Some(wgpu::ColorTargetState {
                                    format: context.texture_format(),
                                    blend: None,
                                    write_mask: wgpu::ColorWrites::ALL,
                                })],
                                compilation_options: wgpu::PipelineCompilationOptions::default(),
                            }),
                            primitive: wgpu::PrimitiveState::default(),
                            depth_stencil: None,
                            multisample: wgpu::MultisampleState::default(),
                            multiview_mask: None,
                            cache: None,
                        });
                (spec.id.to_string(), pipeline)
            })
            .collect::<HashMap<_, _>>();

        Self {
            uniform_bind_group_layout,
            pipelines,
        }
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            let uniform_buffer =
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: bytemuck::bytes_of(&pack_effect_uniforms(pass, width, height)?),
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    });
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }
}

fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let spec = shader_spec(&pass.shader).ok_or_else(|| EffectsError::UnknownEffectShader {
        shader: pass.shader.clone(),
    })?;

    for uniform in pass.uniforms.keys() {
        if !spec.uniforms.iter().any(|(name, _)| name == uniform) {
            return Err(EffectsError::UnsupportedUniform {
                shader: pass.shader.clone(),
                uniform: uniform.clone(),
            });
        }
    }

    let mut buffer = EffectUniformBuffer {
        resolution: [width as f32, height as f32],
        direction: [0.0, 0.0],
        scalars: [0.0; 4],
    };
    for (name, slot) in spec.uniforms {
        match slot {
            UniformSlot::Direction => buffer.direction = read_vec2_uniform(pass, name)?,
            UniformSlot::Scalar(index) => buffer.scalars[*index] = read_number_uniform(pass, name)?,
        }
    }
    Ok(buffer)
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Number(value) => Ok(*value),
        UniformValue::Vector(_) => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vec2_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 2], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    };
    if values.len() != 2 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    }
    Ok([values[0], values[1]])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass(shader: &str, uniforms: &[(&str, UniformValue)]) -> EffectPass {
        EffectPass {
            shader: shader.to_string(),
            uniforms: uniforms
                .iter()
                .map(|(name, value)| (name.to_string(), value.clone()))
                .collect(),
        }
    }

    #[test]
    fn every_shader_is_valid_wgsl() {
        use wgpu::naga;
        for spec in SHADERS {
            let module = naga::front::wgsl::parse_str(spec.source)
                .unwrap_or_else(|error| panic!("{}: {}", spec.id, error.emit_to_string(spec.source)));
            naga::valid::Validator::new(
                naga::valid::ValidationFlags::all(),
                naga::valid::Capabilities::empty(),
            )
            .validate(&module)
            .unwrap_or_else(|error| panic!("{}: {error:?}", spec.id));
            assert!(
                module.entry_points.iter().any(|entry| entry.name == "fragment_main"),
                "{} has no fragment_main",
                spec.id
            );
        }
    }

    #[test]
    fn shader_ids_are_unique() {
        for (index, spec) in SHADERS.iter().enumerate() {
            assert!(
                SHADERS[index + 1..].iter().all(|other| other.id != spec.id),
                "duplicate shader id {}",
                spec.id
            );
        }
    }

    #[test]
    fn blur_uniforms_keep_their_layout() {
        let buffer = pack_effect_uniforms(
            &pass(
                "gaussian-blur",
                &[
                    ("u_sigma", UniformValue::Number(3.0)),
                    ("u_step", UniformValue::Number(2.0)),
                    ("u_direction", UniformValue::Vector(vec![1.0, 0.0])),
                ],
            ),
            1920,
            1080,
        )
        .unwrap();
        assert_eq!(buffer.resolution, [1920.0, 1080.0]);
        assert_eq!(buffer.direction, [1.0, 0.0]);
        assert_eq!(buffer.scalars, [3.0, 2.0, 0.0, 0.0]);
    }

    #[test]
    fn packs_named_uniforms_into_their_slots() {
        let buffer = pack_effect_uniforms(
            &pass(
                "wave",
                &[
                    ("u_amplitude", UniformValue::Number(12.0)),
                    ("u_frequency", UniformValue::Number(4.0)),
                    ("u_phase", UniformValue::Number(0.25)),
                ],
            ),
            100,
            100,
        )
        .unwrap();
        assert_eq!(buffer.scalars, [12.0, 4.0, 0.25, 0.0]);
    }

    #[test]
    fn rejects_unknown_and_missing_uniforms() {
        let unknown = pack_effect_uniforms(
            &pass(
                "posterize",
                &[
                    ("u_levels", UniformValue::Number(4.0)),
                    ("u_sigma", UniformValue::Number(1.0)),
                ],
            ),
            1,
            1,
        );
        assert!(matches!(unknown, Err(EffectsError::UnsupportedUniform { .. })));

        let missing = pack_effect_uniforms(&pass("posterize", &[]), 1, 1);
        assert!(matches!(missing, Err(EffectsError::MissingUniform { .. })));

        let unknown_shader = pack_effect_uniforms(&pass("nope", &[]), 1, 1);
        assert!(matches!(unknown_shader, Err(EffectsError::UnknownEffectShader { .. })));
    }
}
