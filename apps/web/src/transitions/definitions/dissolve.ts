import type { TransitionDefinition } from "../types";
import { clamp01, readNumber } from "./shared";

export const fadeTransitionDefinition: TransitionDefinition = {
	type: "fade",
	name: "Fade",
	keywords: ["fade", "dissolve", "cross", "crossfade", "mix"],
	params: [],
	render({ progress }) {
		return {
			from: {},
			to: { opacity: progress },
		};
	},
};

export const dipTransitionDefinition: TransitionDefinition = {
	type: "dip",
	name: "Dip to Color",
	keywords: ["dip", "black", "white", "fade", "flash"],
	params: [
		{
			key: "color",
			label: "Color",
			type: "color",
			default: "#000000",
			keyframable: false,
		},
	],
	render({ progress, params }) {
		const isFirstHalf = progress < 0.5;
		return {
			from: { opacity: isFirstHalf ? 1 : 0 },
			to: { opacity: isFirstHalf ? 0 : 1 },
			overlay: {
				color: String(params.color ?? "#000000"),
				opacity: 1 - Math.abs(progress * 2 - 1),
			},
		};
	},
};

export const blurTransitionDefinition: TransitionDefinition = {
	type: "blur",
	name: "Blur",
	keywords: ["blur", "defocus", "dissolve", "soft"],
	params: [
		{
			key: "intensity",
			label: "Intensity",
			type: "number",
			default: 50,
			min: 1,
			max: 100,
			step: 1,
			keyframable: false,
		},
	],
	render({ progress, params, width }) {
		const intensity = readNumber({ params, key: "intensity", fallback: 50 });
		const maxSigma = (width * 0.04 * intensity) / 100;
		return {
			from: { blur: maxSigma * clamp01(progress * 2) },
			to: {
				opacity: clamp01((progress - 0.25) * 2),
				blur: maxSigma * clamp01((1 - progress) * 2),
			},
		};
	},
};
