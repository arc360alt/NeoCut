struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

// scalars: x = block size in pixels.
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let block = max(uniforms.scalars.x, 1.0);
    let pixel = input.tex_coord * uniforms.resolution;
    let block_center = (floor(pixel / block) + vec2f(0.5)) * block;
    return textureSampleLevel(input_texture, input_sampler, block_center / uniforms.resolution, 0.0);
}
