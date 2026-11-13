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

// scalars: x = amplitude in pixels, y = waves across the frame height,
// z = phase in turns (keyframe it to animate).
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let amplitude = uniforms.scalars.x / uniforms.resolution.x;
    let angle = (input.tex_coord.y * uniforms.scalars.y + uniforms.scalars.z) * 6.283185307;
    let uv = vec2f(input.tex_coord.x + sin(angle) * amplitude, input.tex_coord.y);
    return textureSampleLevel(input_texture, input_sampler, uv, 0.0);
}
