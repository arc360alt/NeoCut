import { BaseNode } from "./base-node";
import type { Effect, EffectPass } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { BlendMode, Transform } from "@/rendering";
import type { ParamValues } from "@/params";
import type { CompoundElement, RetimeConfig, VisualElement } from "@/timeline";
import type { TransitionLayerState } from "@/transitions";
import type { Adjustments } from "@/adjustments";

/** A transition this node takes part in, in timeline ticks. */
export interface NodeTransition {
	type: string;
	params: ParamValues;
	start: number;
	end: number;
}

export interface VisualNodeParams {
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	transform: Transform;
	animations?: VisualElement["animations"];
	opacity: number;
	blendMode?: BlendMode;
	effects?: Effect[];
	masks?: Mask[];
	/** Transition from the previous clip; may start before `timeOffset`. */
	transitionIn?: NodeTransition;
	/** Transition into the next clip; may end after the clip does. */
	transitionOut?: NodeTransition;
	/** Base color/blur adjustments, before keyframes. */
	adjustments?: Adjustments;
	/**
	 * Compound clips (outermost first) this node sits inside; their transform,
	 * opacity and effects apply on top of its own.
	 */
	compoundParents?: readonly CompoundElement[];
}

export interface ResolvedVisualNodeState {
	localTime: number;
	transform: Transform;
	opacity: number;
	effectPasses: EffectPass[][];
	transition: TransitionLayerState | null;
	/** Null when the picture is untouched. */
	adjustments: Adjustments | null;
}

export interface ResolvedVisualSourceNodeState extends ResolvedVisualNodeState {
	source: CanvasImageSource;
	/** Timestamp of a decoded video frame; its canvas may be reused later. */
	sourceVersion?: number;
	/** False when the source has transparent pixels (only tracked for video). */
	sourceOpaque?: boolean;
	sourceWidth: number;
	sourceHeight: number;
}

export abstract class VisualNode<
	Params extends VisualNodeParams = VisualNodeParams,
	Resolved extends ResolvedVisualNodeState = ResolvedVisualNodeState,
> extends BaseNode<Params, Resolved> {}
