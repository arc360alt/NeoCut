import type { TransitionDefinition } from "../types";
import {
	HORIZONTAL_DIRECTION_PARAM,
	easeInOutCubic,
	readDirection,
} from "./shared";

const CUBE_PIVOT_DEPTH = 0.5;

export const cubeTransitionDefinition: TransitionDefinition = {
	type: "cube",
	name: "Cube",
	keywords: ["cube", "3d", "rotate", "box", "turn"],
	params: [HORIZONTAL_DIRECTION_PARAM],
	render({ progress, params }) {
		// Positive angles turn a face toward the left edge.
		const sign = readDirection({ params }) === "right" ? -1 : 1;
		const eased = easeInOutCubic(progress);
		return {
			from: {
				rotateY: { angle: sign * eased * 90, pivotDepth: CUBE_PIVOT_DEPTH },
			},
			to: {
				rotateY: {
					angle: -sign * (1 - eased) * 90,
					pivotDepth: CUBE_PIVOT_DEPTH,
				},
			},
		};
	},
};

export const flipTransitionDefinition: TransitionDefinition = {
	type: "flip",
	name: "Flip",
	keywords: ["flip", "card", "3d", "turn", "rotate"],
	params: [HORIZONTAL_DIRECTION_PARAM],
	render({ progress, params }) {
		const sign = readDirection({ params }) === "right" ? -1 : 1;
		const eased = easeInOutCubic(progress);
		const isFirstHalf = eased < 0.5;
		return {
			from: isFirstHalf
				? { rotateY: { angle: sign * eased * 180, pivotDepth: 0 } }
				: { opacity: 0 },
			to: isFirstHalf
				? { opacity: 0 }
				: { rotateY: { angle: -sign * (1 - eased) * 180, pivotDepth: 0 } },
		};
	},
};
