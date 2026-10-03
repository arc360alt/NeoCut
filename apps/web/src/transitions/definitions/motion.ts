import type { TransitionDefinition } from "../types";
import {
	DIRECTION_PARAM,
	directionVector,
	easeInOutCubic,
	readDirection,
} from "./shared";

export const slideTransitionDefinition: TransitionDefinition = {
	type: "slide",
	name: "Slide",
	keywords: ["slide", "cover", "move", "enter"],
	params: [DIRECTION_PARAM],
	render({ progress, params, width, height }) {
		const vector = directionVector({ direction: readDirection({ params }) });
		const remaining = 1 - easeInOutCubic(progress);
		return {
			from: {},
			to: {
				offsetX: -vector.x * remaining * width,
				offsetY: -vector.y * remaining * height,
			},
		};
	},
};

export const pushTransitionDefinition: TransitionDefinition = {
	type: "push",
	name: "Push",
	keywords: ["push", "slide", "move", "swipe"],
	params: [DIRECTION_PARAM],
	render({ progress, params, width, height }) {
		const vector = directionVector({ direction: readDirection({ params }) });
		const eased = easeInOutCubic(progress);
		return {
			from: {
				offsetX: vector.x * eased * width,
				offsetY: vector.y * eased * height,
			},
			to: {
				offsetX: -vector.x * (1 - eased) * width,
				offsetY: -vector.y * (1 - eased) * height,
			},
		};
	},
};

export const zoomTransitionDefinition: TransitionDefinition = {
	type: "zoom",
	name: "Zoom",
	keywords: ["zoom", "scale", "punch", "through"],
	params: [],
	render({ progress }) {
		const eased = easeInOutCubic(progress);
		return {
			from: { scale: 1 + eased * 1.5, opacity: 1 - eased },
			to: { scale: 0.4 + eased * 0.6, opacity: eased },
		};
	},
};

export const spinTransitionDefinition: TransitionDefinition = {
	type: "spin",
	name: "Spin",
	keywords: ["spin", "rotate", "twirl", "swirl"],
	params: [],
	render({ progress }) {
		const eased = easeInOutCubic(progress);
		return {
			from: {
				rotate: eased * 180,
				scale: 1 - eased,
				opacity: 1 - eased * 0.5,
			},
			to: {
				rotate: (eased - 1) * 180,
				scale: eased,
				opacity: 0.5 + eased * 0.5,
			},
		};
	},
};
