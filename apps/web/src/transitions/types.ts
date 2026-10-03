import type { ParamDefinition, ParamValues } from "@/params";

export type TransitionClipContext =
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D;

/**
 * A reveal shape in canvas space. Opaque pixels keep the layer visible,
 * transparent pixels hide it.
 */
export interface TransitionClip {
	/** Stable description of the shape, used for texture caching. */
	key: string;
	draw(context: {
		ctx: TransitionClipContext;
		width: number;
		height: number;
	}): void;
}

/** How one side of a transition is drawn at a given moment. */
export interface TransitionLayerState {
	/** Multiplied with the layer's own opacity. */
	opacity?: number;
	/** Canvas pixels. */
	offsetX?: number;
	offsetY?: number;
	/** Multiplied with the layer's own size. */
	scale?: number;
	/** Horizontal-only scale, applied on top of `scale`. */
	scaleX?: number;
	/** Degrees, added to the layer's own rotation. */
	rotate?: number;
	/** Gaussian blur sigma in canvas pixels. */
	blur?: number;
	clip?: TransitionClip;
	/**
	 * Rotation around the vertical axis with perspective. `pivotDepth` is the
	 * distance of the rotation axis behind the layer, as a fraction of its
	 * width (0 = spin in place, 0.5 = cube face).
	 */
	rotateY?: { angle: number; pivotDepth: number };
}

export interface TransitionFrame {
	/** The outgoing clip. */
	from: TransitionLayerState;
	/** The incoming clip, drawn above the outgoing one. */
	to: TransitionLayerState;
	/** A solid color drawn above both clips. */
	overlay?: { color: string; opacity: number };
}

export interface TransitionRenderContext {
	/** 0 at the start of the transition, 1 at the end. */
	progress: number;
	params: ParamValues;
	width: number;
	height: number;
}

export interface TransitionDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	render(context: TransitionRenderContext): TransitionFrame;
}

export type TransitionRole = "from" | "to";
