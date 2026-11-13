import { hasKeyframesForPath, upsertPathKeyframe } from "@/animation";
import type { AnimationPath, ElementAnimations } from "@/animation/types";
import {
	coerceParamValue,
	getParamChannelLayout,
	type ParamValues,
} from "@/params";
import { getElementParam } from "@/params/registry";
import type { Transform } from "@/rendering";
import type { TimelineElement } from "@/timeline";
import { mediaTime } from "@/wasm";

const TRANSFORM_VALUES: ReadonlyArray<
	readonly [AnimationPath, (transform: Transform) => number]
> = [
	["transform.positionX", (transform) => transform.position.x],
	["transform.positionY", (transform) => transform.position.y],
	["transform.scaleX", (transform) => transform.scaleX],
	["transform.scaleY", (transform) => transform.scaleY],
	["transform.rotate", (transform) => transform.rotate],
];

/**
 * The element update that makes `transform` its transform at `localTime`,
 * the way the Properties panel edits values: a value with keyframes gets a
 * keyframe at the playhead (added, or the one there updated); any other
 * value is set directly. Viewer gestures (move, resize, rotate) use this so
 * they never wipe an animation or get overridden by one.
 *
 * Built from the element as it was when the gesture started, so repeated
 * calls during a drag don't pile up changes.
 */
export function buildTransformWrite({
	element,
	transform,
	localTime,
}: {
	element: TimelineElement;
	transform: Transform;
	/** Ticks into the element, as `getElementLocalTime` returns. */
	localTime: number;
}): { params: ParamValues; animations?: ElementAnimations } {
	const params: ParamValues = { ...element.params };
	let animations = element.animations;
	let animationsChanged = false;

	for (const [path, read] of TRANSFORM_VALUES) {
		const value = read(transform);
		if (!hasKeyframesForPath({ animations, propertyPath: path })) {
			params[path] = value;
			continue;
		}
		const param = getElementParam({ element, key: path });
		if (!param) {
			params[path] = value;
			continue;
		}
		animations = upsertPathKeyframe({
			animations,
			propertyPath: path,
			time: mediaTime({ ticks: Math.round(localTime) }),
			value,
			channelLayout: getParamChannelLayout({ param }),
			coerceValue: ({ value: next }) => coerceParamValue({ param, value: next }),
		});
		animationsChanged = true;
	}

	return animationsChanged ? { params, animations } : { params };
}
