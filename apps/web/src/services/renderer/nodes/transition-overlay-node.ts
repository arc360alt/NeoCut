import { BaseNode } from "./base-node";
import type { NodeTransition } from "./visual-node";

export type TransitionOverlayNodeParams = NodeTransition;

export type ResolvedTransitionOverlayNodeState = {
	color: string;
	opacity: number;
};

/** The solid color some transitions draw above both clips, e.g. dip to black. */
export class TransitionOverlayNode extends BaseNode<
	TransitionOverlayNodeParams,
	ResolvedTransitionOverlayNodeState
> {}
