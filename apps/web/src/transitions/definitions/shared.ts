import type { ParamDefinition, ParamValues } from "@/params";

export type TransitionDirection = "left" | "right" | "up" | "down";

export const DIRECTION_PARAM: ParamDefinition<"direction"> = {
	key: "direction",
	label: "Direction",
	type: "select",
	default: "left",
	keyframable: false,
	options: [
		{ value: "left", label: "Left" },
		{ value: "right", label: "Right" },
		{ value: "up", label: "Up" },
		{ value: "down", label: "Down" },
	],
};

export const HORIZONTAL_DIRECTION_PARAM: ParamDefinition<"direction"> = {
	key: "direction",
	label: "Direction",
	type: "select",
	default: "left",
	keyframable: false,
	options: [
		{ value: "left", label: "Left" },
		{ value: "right", label: "Right" },
	],
};

export const SOFTNESS_PARAM: ParamDefinition<"softness"> = {
	key: "softness",
	label: "Softness",
	type: "number",
	default: 10,
	min: 0,
	max: 100,
	step: 1,
	unit: "percent",
	keyframable: false,
};

export function readDirection({
	params,
}: {
	params: ParamValues;
}): TransitionDirection {
	const value = params.direction;
	return value === "right" || value === "up" || value === "down"
		? value
		: "left";
}

/** Unit vector pointing the way the picture moves. */
export function directionVector({
	direction,
}: {
	direction: TransitionDirection;
}): { x: number; y: number } {
	switch (direction) {
		case "left":
			return { x: -1, y: 0 };
		case "right":
			return { x: 1, y: 0 };
		case "up":
			return { x: 0, y: -1 };
		case "down":
			return { x: 0, y: 1 };
	}
}

export function readNumber({
	params,
	key,
	fallback,
}: {
	params: ParamValues;
	key: string;
	fallback: number;
}): number {
	const value = Number(params[key]);
	return Number.isFinite(value) ? value : fallback;
}

export function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function clamp01(t: number): number {
	return Math.max(0, Math.min(1, t));
}
