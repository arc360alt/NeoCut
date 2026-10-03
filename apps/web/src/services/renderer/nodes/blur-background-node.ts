import type { EffectPass } from "@/effects/types";
import type { RetimeConfig } from "@/timeline";
import { BaseNode } from "./base-node";

export type BlurBackgroundNodeParams = {
	mediaId: string;
	url: string;
	file: File;
	mediaType: "video" | "image";
	duration: number;
	timeOffset: number;
	trimStart: number;
	trimEnd: number;
	retime?: RetimeConfig;
	blurIntensity: number;
};

export type BackdropSource = {
	source: CanvasImageSource;
	/** Timestamp of a decoded video frame; its canvas may be reused later. */
	version?: number;
	width: number;
	height: number;
};

export interface ResolvedBlurBackgroundNodeState {
	backdropSource: BackdropSource;
	passes: EffectPass[];
}

export class BlurBackgroundNode extends BaseNode<
	BlurBackgroundNodeParams,
	ResolvedBlurBackgroundNodeState
> {}
