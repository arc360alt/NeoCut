import type { ElementAnimations } from "@/animation/types";
import type { NumberParamDefinition, ParamValues } from "@/params";
import type { ElementType } from "@/timeline";

export const ADJUSTMENT_KEYS = {
	brightness: "adjust.brightness",
	contrast: "adjust.contrast",
	saturation: "adjust.saturation",
	hue: "adjust.hue",
	temperature: "adjust.temperature",
	tint: "adjust.tint",
	vignette: "adjust.vignette",
	blur: "adjust.blur",
} as const;

export type AdjustmentName = keyof typeof ADJUSTMENT_KEYS;
export type Adjustments = Record<AdjustmentName, number>;

export const ADJUSTMENT_NAMES: AdjustmentName[] = [
	"brightness",
	"contrast",
	"saturation",
	"hue",
	"temperature",
	"tint",
	"vignette",
	"blur",
];

export const ADJUSTMENT_PARAM_KEYS = Object.values(ADJUSTMENT_KEYS);

export const ADJUSTABLE_ELEMENT_TYPES = [
	"video",
	"image",
	"text",
	"sticker",
	"graphic",
] as const satisfies readonly ElementType[];

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
	brightness: 0,
	contrast: 0,
	saturation: 0,
	hue: 0,
	temperature: 0,
	tint: 0,
	vignette: 0,
	blur: 0,
};

function signedPercentParam({
	name,
	label,
}: {
	name: AdjustmentName;
	label: string;
}): NumberParamDefinition {
	return {
		key: ADJUSTMENT_KEYS[name],
		label,
		type: "number",
		default: 0,
		min: -100,
		max: 100,
		step: 1,
	};
}

/** Element params for color and blur adjustments, all neutral at 0. */
export const ADJUSTMENT_PARAMS: NumberParamDefinition[] = [
	signedPercentParam({ name: "brightness", label: "Brightness" }),
	signedPercentParam({ name: "contrast", label: "Contrast" }),
	signedPercentParam({ name: "saturation", label: "Saturation" }),
	{
		key: ADJUSTMENT_KEYS.hue,
		label: "Hue",
		type: "number",
		default: 0,
		min: -180,
		max: 180,
		step: 1,
	},
	signedPercentParam({ name: "temperature", label: "Temperature" }),
	signedPercentParam({ name: "tint", label: "Tint" }),
	{
		key: ADJUSTMENT_KEYS.vignette,
		label: "Vignette",
		type: "number",
		default: 0,
		min: 0,
		max: 100,
		step: 1,
	},
	{
		key: ADJUSTMENT_KEYS.blur,
		label: "Blur",
		type: "number",
		default: 0,
		min: 0,
		max: 100,
		step: 1,
	},
];

export interface AdjustmentPreset {
	id: string;
	name: string;
	values: Partial<Adjustments>;
}

export const ADJUSTMENT_PRESETS: AdjustmentPreset[] = [
	{ id: "none", name: "Original", values: {} },
	{
		id: "vivid",
		name: "Vivid",
		values: { contrast: 15, saturation: 35, brightness: 3 },
	},
	{
		id: "warm",
		name: "Warm",
		values: { temperature: 35, saturation: 10, tint: 5 },
	},
	{ id: "cool", name: "Cool", values: { temperature: -35, tint: -5 } },
	{
		id: "black-white",
		name: "B&W",
		values: { saturation: -100, contrast: 20 },
	},
	{
		id: "vintage",
		name: "Vintage",
		values: {
			saturation: -35,
			contrast: -10,
			temperature: 30,
			brightness: 5,
			vignette: 45,
		},
	},
	{
		id: "moody",
		name: "Moody",
		values: {
			brightness: -12,
			contrast: 25,
			saturation: -20,
			temperature: -15,
			vignette: 55,
		},
	},
	{ id: "dreamy", name: "Dreamy", values: { brightness: 10, contrast: -15, blur: 4 } },
];

export function isAdjustableElementType(
	type: ElementType,
): type is (typeof ADJUSTABLE_ELEMENT_TYPES)[number] {
	return (ADJUSTABLE_ELEMENT_TYPES as readonly ElementType[]).includes(type);
}

/** Params that set every adjustment to the preset's value (others to neutral). */
export function buildPresetParams({
	preset,
}: {
	preset: AdjustmentPreset;
}): ParamValues {
	const params: ParamValues = {};
	for (const name of ADJUSTMENT_NAMES) {
		params[ADJUSTMENT_KEYS[name]] = preset.values[name] ?? 0;
	}
	return params;
}

export function readAdjustmentsFromParams({
	params,
}: {
	params: ParamValues;
}): Adjustments {
	const adjustments = { ...NEUTRAL_ADJUSTMENTS };
	for (const name of ADJUSTMENT_NAMES) {
		const value = Number(params[ADJUSTMENT_KEYS[name]]);
		if (Number.isFinite(value)) {
			adjustments[name] = value;
		}
	}
	return adjustments;
}

export function isNeutralAdjustments({
	adjustments,
}: {
	adjustments: Adjustments;
}): boolean {
	return ADJUSTMENT_NAMES.every((name) => adjustments[name] === 0);
}

export function hasAdjustmentAnimations({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): boolean {
	if (!animations) {
		return false;
	}
	return ADJUSTMENT_PARAM_KEYS.some((key) => animations[key] !== undefined);
}

/**
 * Applies keyframes on top of the base values. Returns null when the result
 * leaves the picture untouched, so callers can skip the extra work.
 */
export function resolveAdjustmentsAtTime({
	base,
	animations,
	localTime,
	resolveValue,
}: {
	base: Adjustments;
	animations: ElementAnimations | undefined;
	localTime: number;
	resolveValue: (args: {
		animations: ElementAnimations | undefined;
		propertyPath: string;
		localTime: number;
		fallbackValue: number;
	}) => number;
}): Adjustments | null {
	const resolved = { ...base };
	if (hasAdjustmentAnimations({ animations })) {
		for (const name of ADJUSTMENT_NAMES) {
			resolved[name] = resolveValue({
				animations,
				propertyPath: ADJUSTMENT_KEYS[name],
				localTime: Math.max(0, localTime),
				fallbackValue: base[name],
			});
		}
	}
	return isNeutralAdjustments({ adjustments: resolved }) ? null : resolved;
}

/** The part of an adjustment a CSS / canvas `filter` can express. */
export function buildAdjustmentFilter({
	adjustments,
}: {
	adjustments: Adjustments;
}): string {
	const filters: string[] = [];
	if (adjustments.brightness !== 0) {
		filters.push(`brightness(${Math.max(0, 1 + adjustments.brightness / 100)})`);
	}
	if (adjustments.contrast !== 0) {
		filters.push(`contrast(${Math.max(0, 1 + adjustments.contrast / 100)})`);
	}
	if (adjustments.saturation !== 0) {
		filters.push(`saturate(${Math.max(0, 1 + adjustments.saturation / 100)})`);
	}
	if (adjustments.hue !== 0) {
		filters.push(`hue-rotate(${adjustments.hue}deg)`);
	}
	return filters.length > 0 ? filters.join(" ") : "none";
}

/** Blur sigma in pixels for an output of the given size. */
export function adjustmentBlurSigma({
	blur,
	width,
}: {
	blur: number;
	width: number;
}): number {
	return Math.max(0, (blur / 5) * (width / 1920));
}
