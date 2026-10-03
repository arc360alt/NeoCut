import { describe, expect, test } from "bun:test";
import {
	ADJUSTMENT_KEYS,
	ADJUSTMENT_PRESETS,
	NEUTRAL_ADJUSTMENTS,
	buildAdjustmentFilter,
	buildPresetParams,
	readAdjustmentsFromParams,
	resolveAdjustmentsAtTime,
} from "..";

const noAnimation = ({ fallbackValue }: { fallbackValue: number }) =>
	fallbackValue;

describe("readAdjustmentsFromParams", () => {
	test("defaults to neutral", () => {
		expect(readAdjustmentsFromParams({ params: {} })).toEqual(NEUTRAL_ADJUSTMENTS);
	});

	test("reads stored values", () => {
		const adjustments = readAdjustmentsFromParams({
			params: { [ADJUSTMENT_KEYS.saturation]: -40, opacity: 1 },
		});
		expect(adjustments.saturation).toBe(-40);
		expect(adjustments.brightness).toBe(0);
	});
});

describe("buildAdjustmentFilter", () => {
	test("is none when neutral", () => {
		expect(buildAdjustmentFilter({ adjustments: NEUTRAL_ADJUSTMENTS })).toBe("none");
	});

	test("maps percentages onto CSS filter functions", () => {
		expect(
			buildAdjustmentFilter({
				adjustments: {
					...NEUTRAL_ADJUSTMENTS,
					brightness: 20,
					contrast: -50,
					saturation: -100,
					hue: 90,
				},
			}),
		).toBe("brightness(1.2) contrast(0.5) saturate(0) hue-rotate(90deg)");
	});
});

describe("resolveAdjustmentsAtTime", () => {
	test("returns null for an untouched picture", () => {
		expect(
			resolveAdjustmentsAtTime({
				base: NEUTRAL_ADJUSTMENTS,
				animations: undefined,
				localTime: 0,
				resolveValue: noAnimation,
			}),
		).toBeNull();
	});

	test("uses keyframed values when present", () => {
		const resolved = resolveAdjustmentsAtTime({
			base: NEUTRAL_ADJUSTMENTS,
			animations: { [ADJUSTMENT_KEYS.blur]: { keys: [] } },
			localTime: 10,
			resolveValue: ({ propertyPath, fallbackValue }) =>
				propertyPath === ADJUSTMENT_KEYS.blur ? 30 : fallbackValue,
		});
		expect(resolved?.blur).toBe(30);
	});
});

describe("presets", () => {
	test("set every adjustment so switching presets fully replaces the look", () => {
		for (const preset of ADJUSTMENT_PRESETS) {
			const params = buildPresetParams({ preset });
			expect(Object.keys(params).sort()).toEqual(
				Object.values(ADJUSTMENT_KEYS).sort(),
			);
		}
	});

	test("the original preset is neutral", () => {
		const params = buildPresetParams({ preset: ADJUSTMENT_PRESETS[0] });
		expect(readAdjustmentsFromParams({ params })).toEqual(NEUTRAL_ADJUSTMENTS);
	});
});

describe("buildAdjustmentColorMatrix", async () => {
	const { buildAdjustmentColorMatrix } = await import(
		"@/services/renderer/adjustments"
	);
	const applyToGray = ({ value, matrix }: { value: number; matrix: number[] }) =>
		matrix[0] * value + matrix[1] * value + matrix[2] * value + matrix[4];

	test("is the identity when neutral", () => {
		const matrix = buildAdjustmentColorMatrix({ adjustments: NEUTRAL_ADJUSTMENTS });
		expect(applyToGray({ value: 0.4, matrix })).toBeCloseTo(0.4);
	});

	test("applies brightness before contrast, like the CSS filter chain", () => {
		const matrix = buildAdjustmentColorMatrix({
			adjustments: { ...NEUTRAL_ADJUSTMENTS, brightness: 20, contrast: -50 },
		});
		// brightness(1.2): 0.4 -> 0.48; contrast(0.5): 0.48 * 0.5 + 0.25 = 0.49
		expect(applyToGray({ value: 0.4, matrix })).toBeCloseTo(0.49);
	});

	test("full desaturation turns a color gray", () => {
		const matrix = buildAdjustmentColorMatrix({
			adjustments: { ...NEUTRAL_ADJUSTMENTS, saturation: -100 },
		});
		const [r, g, b] = [1, 0, 0];
		const red = matrix[0] * r + matrix[1] * g + matrix[2] * b;
		const green = matrix[5] * r + matrix[6] * g + matrix[7] * b;
		const blue = matrix[10] * r + matrix[11] * g + matrix[12] * b;
		expect(red).toBeCloseTo(0.213);
		expect(green).toBeCloseTo(0.213);
		expect(blue).toBeCloseTo(0.213);
	});
});

describe("buildAdjustmentColorMatrix with colors", async () => {
	const { buildAdjustmentColorMatrix } = await import(
		"@/services/renderer/adjustments"
	);

	test("keeps colors unchanged when neutral", () => {
		const matrix = buildAdjustmentColorMatrix({ adjustments: NEUTRAL_ADJUSTMENTS });
		expect(matrix).toEqual([1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0]);
	});

	test("a 120 degree hue rotation moves red most of the way to green", () => {
		const matrix = buildAdjustmentColorMatrix({
			adjustments: { ...NEUTRAL_ADJUSTMENTS, hue: 120 },
		});
		const red = matrix[0];
		const green = matrix[5];
		expect(green).toBeGreaterThan(red);
	});
});
