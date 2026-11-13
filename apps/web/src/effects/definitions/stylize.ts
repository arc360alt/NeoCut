import type { ParamValues } from "@/params";
import type { EffectDefinition } from "@/effects/types";

/** Pixel-sized settings are authored for a 1920px-wide frame and scaled to the real one. */
const REFERENCE_WIDTH = 1920;

function readNumber({
	effectParams,
	key,
	fallback,
}: {
	effectParams: ParamValues;
	key: string;
	fallback: number;
}): number {
	const raw = effectParams[key];
	const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	return Number.isFinite(value) ? value : fallback;
}

function scaleToFrame({ pixels, width }: { pixels: number; width: number }): number {
	return pixels * (width / REFERENCE_WIDTH);
}

export const vignetteEffectDefinition: EffectDefinition = {
	type: "vignette",
	name: "Vignette",
	keywords: ["vignette", "dark edges", "corners", "cinematic"],
	params: [
		{ key: "amount", label: "Amount", type: "number", default: 60, min: 0, max: 100, step: 1 },
		{ key: "size", label: "Size", type: "number", default: 45, min: 0, max: 100, step: 1 },
		{ key: "softness", label: "Softness", type: "number", default: 50, min: 1, max: 100, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: "vignette",
				uniforms: ({ effectParams }) => ({
					u_amount: readNumber({ effectParams, key: "amount", fallback: 60 }) / 100,
					u_size: readNumber({ effectParams, key: "size", fallback: 45 }) / 100,
					u_softness: readNumber({ effectParams, key: "softness", fallback: 50 }) / 100,
				}),
			},
		],
	},
};

export const pixelateEffectDefinition: EffectDefinition = {
	type: "pixelate",
	name: "Pixelate",
	keywords: ["pixelate", "pixel", "mosaic", "censor", "8-bit", "retro"],
	params: [
		{ key: "blockSize", label: "Block size", type: "number", default: 24, min: 1, max: 200, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: "pixelate",
				uniforms: ({ effectParams, width }) => ({
					u_block_size: Math.max(
						1,
						scaleToFrame({
							pixels: readNumber({ effectParams, key: "blockSize", fallback: 24 }),
							width,
						}),
					),
				}),
			},
		],
	},
};

export const rgbSplitEffectDefinition: EffectDefinition = {
	type: "rgb-split",
	name: "RGB Split",
	keywords: ["rgb", "split", "chromatic aberration", "glitch", "color shift"],
	params: [
		{ key: "distance", label: "Distance", type: "number", default: 12, min: 0, max: 100, step: 1 },
		{ key: "angle", label: "Angle", type: "number", default: 0, min: -180, max: 180, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: "rgb-split",
				uniforms: ({ effectParams, width }) => {
					const radians =
						(readNumber({ effectParams, key: "angle", fallback: 0 }) * Math.PI) / 180;
					return {
						u_distance: scaleToFrame({
							pixels: readNumber({ effectParams, key: "distance", fallback: 12 }),
							width,
						}),
						u_direction: [Math.cos(radians), Math.sin(radians)],
					};
				},
			},
		],
	},
};

export const sharpenEffectDefinition: EffectDefinition = {
	type: "sharpen",
	name: "Sharpen",
	keywords: ["sharpen", "sharp", "crisp", "detail", "clarity"],
	params: [
		{ key: "amount", label: "Amount", type: "number", default: 50, min: 0, max: 100, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: "sharpen",
				uniforms: ({ effectParams }) => ({
					// 100 → a strong 3x unsharp mask.
					u_amount: (readNumber({ effectParams, key: "amount", fallback: 50 }) / 100) * 3,
				}),
			},
		],
	},
};

export const posterizeEffectDefinition: EffectDefinition = {
	type: "posterize",
	name: "Posterize",
	keywords: ["posterize", "poster", "comic", "cartoon", "levels", "flat"],
	params: [
		{ key: "levels", label: "Levels", type: "number", default: 5, min: 2, max: 32, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: "posterize",
				uniforms: ({ effectParams }) => ({
					u_levels: Math.round(readNumber({ effectParams, key: "levels", fallback: 5 })),
				}),
			},
		],
	},
};

export const waveEffectDefinition: EffectDefinition = {
	type: "wave",
	name: "Wave",
	keywords: ["wave", "warp", "distort", "ripple", "wobble", "underwater"],
	params: [
		{ key: "amplitude", label: "Amplitude", type: "number", default: 20, min: 0, max: 200, step: 1 },
		{ key: "frequency", label: "Frequency", type: "number", default: 4, min: 0, max: 40, step: 0.5 },
		{ key: "phase", label: "Phase", type: "number", default: 0, min: 0, max: 100, step: 1 },
	],
	renderer: {
		passes: [
			{
				shader: "wave",
				uniforms: ({ effectParams, width }) => ({
					u_amplitude: scaleToFrame({
						pixels: readNumber({ effectParams, key: "amplitude", fallback: 20 }),
						width,
					}),
					u_frequency: readNumber({ effectParams, key: "frequency", fallback: 4 }),
					u_phase: readNumber({ effectParams, key: "phase", fallback: 0 }) / 100,
				}),
			},
		],
	},
};

export const stylizeEffectDefinitions = [
	vignetteEffectDefinition,
	pixelateEffectDefinition,
	rgbSplitEffectDefinition,
	sharpenEffectDefinition,
	posterizeEffectDefinition,
	waveEffectDefinition,
];
