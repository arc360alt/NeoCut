import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";
import type { ElementTransition } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { registerDefaultTransitions } from "./definitions";
import { transitionsRegistry } from "./registry";
import type {
	TransitionDefinition,
	TransitionFrame,
	TransitionLayerState,
	TransitionRole,
} from "./types";

export const DEFAULT_TRANSITION_DURATION_SECONDS = 0.5;
export const MIN_TRANSITION_DURATION_SECONDS = 0.1;
export const MAX_TRANSITION_DURATION_SECONDS = 5;

export function getTransitionDefinitions(): TransitionDefinition[] {
	registerDefaultTransitions();
	return transitionsRegistry.getAll();
}

export function findTransitionDefinition({
	type,
}: {
	type: string;
}): TransitionDefinition | null {
	registerDefaultTransitions();
	return transitionsRegistry.has(type) ? transitionsRegistry.get(type) : null;
}

export function buildTransition({
	type,
	durationSeconds = DEFAULT_TRANSITION_DURATION_SECONDS,
	params,
}: {
	type: string;
	durationSeconds?: number;
	params?: ParamValues;
}): ElementTransition {
	const definition = findTransitionDefinition({ type });
	return {
		type,
		duration: mediaTimeFromSeconds({ seconds: durationSeconds }),
		params: {
			...(definition ? buildDefaultParamValues(definition.params) : {}),
			...(params ?? {}),
		},
	};
}

export function getTransitionProgress({
	time,
	start,
	end,
}: {
	time: number;
	start: number;
	end: number;
}): number {
	if (end <= start) {
		return 1;
	}
	return Math.max(0, Math.min(1, (time - start) / (end - start)));
}

export function resolveTransitionFrame({
	type,
	params,
	progress,
	width,
	height,
}: {
	type: string;
	params: ParamValues;
	progress: number;
	width: number;
	height: number;
}): TransitionFrame | null {
	const definition = findTransitionDefinition({ type });
	if (!definition) {
		return null;
	}
	return definition.render({
		progress,
		params: {
			...buildDefaultParamValues(definition.params),
			...params,
		},
		width,
		height,
	});
}

export function resolveTransitionLayerState({
	role,
	...context
}: {
	role: TransitionRole;
	type: string;
	params: ParamValues;
	progress: number;
	width: number;
	height: number;
}): TransitionLayerState | null {
	return resolveTransitionFrame(context)?.[role] ?? null;
}

export { transitionsRegistry, registerDefaultTransitions };
export {
	canTrackHaveTransitions,
	findCutNearTime,
	findDefaultTransitionTarget,
	getTrackCuts,
	getTransitionWindows,
	isTransitionableElement,
	type TrackCut,
	type TransitionWindow,
} from "./windows";
export type {
	TransitionClip,
	TransitionDefinition,
	TransitionFrame,
	TransitionLayerState,
	TransitionRole,
} from "./types";
