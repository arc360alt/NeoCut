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

// scalars: x = amount (0..1 darkening at the corners), y = size (radius where
// darkening starts, 0..1 of the half-diagonal), z = softness (0..1).
@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let color = textureSample(input_texture, input_sampler, input.tex_coord);
    let amount = clamp(uniforms.scalars.x, 0.0, 1.0);
    let size = clamp(uniforms.scalars.y, 0.0, 1.0);
    let softness = max(uniforms.scalars.z, 0.001);

    // Distance from the centre, corrected for aspect so the falloff is round,
    // normalised so a corner is 1.
    let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
    let offset = (input.tex_coord - vec2f(0.5)) * vec2f(aspect, 1.0);
    let corner = length(vec2f(aspect, 1.0) * 0.5);
    let distance_ratio = length(offset) / corner;

    let darkening = smoothstep(size, size + softness, distance_ratio) * amount;
    return vec4f(color.rgb * (1.0 - darkening), color.a);
}
