import type { TransitionClip, TransitionDefinition } from "../types";
import {
	DIRECTION_PARAM,
	SOFTNESS_PARAM,
	easeInOutCubic,
	readDirection,
	readNumber,
} from "./shared";

const MIN_SOFT_EDGE_PX = 1;

function roundKey(value: number): string {
	return value.toFixed(2);
}

export const wipeTransitionDefinition: TransitionDefinition = {
	type: "wipe",
	name: "Wipe",
	keywords: ["wipe", "reveal", "linear", "edge"],
	params: [DIRECTION_PARAM, SOFTNESS_PARAM],
	render({ progress, params, width, height }) {
		const direction = readDirection({ params });
		const isHorizontal = direction === "left" || direction === "right";
		const length = isHorizontal ? width : height;
		const softness = Math.max(
			MIN_SOFT_EDGE_PX,
			(readNumber({ params, key: "softness", fallback: 10 }) / 100) * length * 0.5,
		);
		// The edge travels the way the picture moves: "left" reveals from the right.
		const travelled = -softness / 2 + progress * (length + softness);
		const isReversed = direction === "left" || direction === "up";
		const edge = isReversed ? length - travelled : travelled;
		const visibleSide = isReversed ? 1 : -1;
		const start = edge + (visibleSide * softness) / 2;
		const end = edge - (visibleSide * softness) / 2;

		const clip: TransitionClip = {
			key: `wipe:${direction}:${roundKey(start)}:${roundKey(end)}`,
			draw({ ctx, width: canvasWidth, height: canvasHeight }) {
				const gradient = isHorizontal
					? ctx.createLinearGradient(start, 0, end, 0)
					: ctx.createLinearGradient(0, start, 0, end);
				gradient.addColorStop(0, "white");
				gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
				ctx.fillStyle = gradient;
				ctx.fillRect(0, 0, canvasWidth, canvasHeight);
			},
		};
		return { from: {}, to: { clip } };
	},
};

export const splitTransitionDefinition: TransitionDefinition = {
	type: "split",
	name: "Split",
	keywords: ["split", "barn", "doors", "open", "reveal"],
	params: [
		{
			key: "orientation",
			label: "Orientation",
			type: "select",
			default: "vertical",
			keyframable: false,
			options: [
				{ value: "vertical", label: "Vertical" },
				{ value: "horizontal", label: "Horizontal" },
			],
		},
	],
	render({ progress, params, width, height }) {
		const isVertical = params.orientation !== "horizontal";
		const eased = easeInOutCubic(progress);
		const length = isVertical ? width : height;
		const opening = eased * length;
		const start = (length - opening) / 2;

		const clip: TransitionClip = {
			key: `split:${isVertical ? "v" : "h"}:${roundKey(opening)}`,
			draw({ ctx, width: canvasWidth, height: canvasHeight }) {
				ctx.fillStyle = "white";
				if (isVertical) {
					ctx.fillRect(start, 0, opening, canvasHeight);
				} else {
					ctx.fillRect(0, start, canvasWidth, opening);
				}
			},
		};
		return { from: {}, to: { clip } };
	},
};

export const irisTransitionDefinition: TransitionDefinition = {
	type: "iris",
	name: "Circle",
	keywords: ["circle", "iris", "round", "reveal", "zoom"],
	params: [SOFTNESS_PARAM],
	render({ progress, params, width, height }) {
		const maxRadius = Math.hypot(width, height) / 2;
		const softness = Math.max(
			MIN_SOFT_EDGE_PX,
			(readNumber({ params, key: "softness", fallback: 10 }) / 100) *
				maxRadius *
				0.5,
		);
		const radius = easeInOutCubic(progress) * (maxRadius + softness);
		const innerRadius = Math.max(0, radius - softness);

		const clip: TransitionClip = {
			key: `iris:${roundKey(radius)}:${roundKey(innerRadius)}`,
			draw({ ctx, width: canvasWidth, height: canvasHeight }) {
				if (radius <= 0) {
					return;
				}
				const centerX = canvasWidth / 2;
				const centerY = canvasHeight / 2;
				const gradient = ctx.createRadialGradient(
					centerX,
					centerY,
					innerRadius,
					centerX,
					centerY,
					radius,
				);
				gradient.addColorStop(0, "white");
				gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
				ctx.fillStyle = gradient;
				ctx.beginPath();
				ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
				ctx.fill();
			},
		};
		return { from: {}, to: { clip } };
	},
};

export const clockWipeTransitionDefinition: TransitionDefinition = {
	type: "clock-wipe",
	name: "Clock Wipe",
	keywords: ["clock", "radial", "wipe", "sweep", "pie"],
	params: [],
	render({ progress }) {
		const sweep = progress * Math.PI * 2;

		const clip: TransitionClip = {
			key: `clock:${sweep.toFixed(4)}`,
			draw({ ctx, width: canvasWidth, height: canvasHeight }) {
				if (sweep <= 0) {
					return;
				}
				const centerX = canvasWidth / 2;
				const centerY = canvasHeight / 2;
				const radius = Math.hypot(canvasWidth, canvasHeight);
				const startAngle = -Math.PI / 2;
				ctx.fillStyle = "white";
				ctx.beginPath();
				ctx.moveTo(centerX, centerY);
				ctx.arc(centerX, centerY, radius, startAngle, startAngle + sweep);
				ctx.closePath();
				ctx.fill();
			},
		};
		return { from: {}, to: { clip } };
	},
};
