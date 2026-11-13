import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { createCanvasSurface } from "./canvas-utils";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { Canvas2dCompositor } from "./compositor/canvas2d-compositor";
import type {
	FrameDescriptor,
	TextureUploadDescriptor,
} from "./compositor/types";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
};

export class CanvasRenderer {
	canvas: OffscreenCanvas;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
	fps: FrameRate;
	/**
	 * Longest side, in pixels, worth decoding video frames at. The preview
	 * sets this from its on-screen size; null (export) means full resolution.
	 */
	sourceSizeLimit: number | null = null;
	/** What frames start from: opaque black, or transparent for alpha exports. */
	clearColor: [number, number, number, number] = [0, 0, 0, 1];
	private canvas2d: Canvas2dCompositor | null = null;

	constructor({ width, height, fps }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	getOutputCanvas(): HTMLCanvasElement {
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		return wasmCompositor.getCanvas();
	}

	/** Returns true when the limit changed and frames should be re-rendered. */
	setSourceSizeLimit({ limit }: { limit: number | null }): boolean {
		if (this.sourceSizeLimit === limit) {
			return false;
		}
		this.sourceSizeLimit = limit;
		return true;
	}

	setSize({ width, height }: { width: number; height: number }) {
		this.width = width;
		this.height = height;

		const surface = createCanvasSurface({ width, height });
		this.canvas = surface.canvas;
		this.context = surface.context;
	}

	/**
	 * Renders one frame for export and returns the image to encode.
	 *
	 * When the frame is just one opaque video covering the canvas exactly (the
	 * common case for a cut-up recording), the decoded frame already is the
	 * output, so the GPU upload, composite and readback are skipped. That
	 * round trip is the slowest part of exporting, especially without
	 * hardware WebGPU.
	 *
	 * Otherwise, frames without GPU-only work (effects, feathered masks) are
	 * drawn with a 2D canvas, which skips that round trip too.
	 */
	async renderFrameSource({
		node,
		time,
	}: {
		node: AnyBaseNode;
		time: number;
	}): Promise<CanvasImageSource> {
		await resolveRenderTree({ node, renderer: this, time });
		const { frame, textures } = await buildFrameDescriptor({ node, renderer: this });
		const passthrough = findPassthroughSource({
			frame,
			textures,
			width: this.width,
			height: this.height,
		});
		if (passthrough) {
			return passthrough;
		}

		if (Canvas2dCompositor.supports({ frame })) {
			this.canvas2d ??= new Canvas2dCompositor();
			this.canvas2d.render({ frame, textures, ctx: this.context });
			return this.canvas;
		}

		wasmCompositor.ensureInitialized({ width: this.width, height: this.height });
		wasmCompositor.syncTextures(textures);
		wasmCompositor.render(frame);
		return wasmCompositor.getCanvas();
	}

	/** Renders one frame into the compositor's canvas (what the preview shows). */
	async render({ node, time }: { node: AnyBaseNode; time: number }) {
		await this.renderFrame({ node, time });
		onRenderPerfFrameComplete();
	}

	private async renderFrame({
		node,
		time,
	}: {
		node: AnyBaseNode;
		time: number;
	}) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		wasmCompositor.ensureInitialized({
			width: this.width,
			height: this.height,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		await this.renderFrame({ node, time });

		const ctx = targetCanvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get target canvas context");
		}

		measureSpanSync({
			name: "drawImage",
			fn: () =>
				ctx.drawImage(
					wasmCompositor.getCanvas(),
					0,
					0,
					targetCanvas.width,
					targetCanvas.height,
				),
		});
		onRenderPerfFrameComplete();
	}
}

/**
 * The decoded frame itself when compositing would reproduce it exactly: the
 * top layer is an opaque video drawn at the canvas size with no transform,
 * transparency, blending, effects or mask (anything beneath it is hidden).
 */
function findPassthroughSource({
	frame,
	textures,
	width,
	height,
}: {
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
	width: number;
	height: number;
}): CanvasImageSource | null {
	const top = frame.items.at(-1);
	if (!top || top.type !== "layer") return null;
	const { transform } = top;
	const coversCanvas =
		transform.centerX === width / 2 &&
		transform.centerY === height / 2 &&
		transform.width === width &&
		transform.height === height &&
		transform.rotationDegrees === 0 &&
		!transform.flipX &&
		!transform.flipY;
	const isPlain =
		top.opacity >= 1 &&
		top.blendMode === "normal" &&
		top.mask === null &&
		top.effectPassGroups.every((group) => group.length === 0);
	if (!coversCanvas || !isPlain) return null;

	const texture = textures.find((candidate) => candidate.id === top.textureId);
	if (
		texture?.kind !== "external" ||
		!texture.opaque ||
		texture.width !== width ||
		texture.height !== height
	) {
		return null;
	}
	return texture.source;
}
