import type { BlendMode } from "@/rendering";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	TextureUploadDescriptor,
} from "./types";

type LayerItem = Extract<FrameItemDescriptor, { type: "layer" }>;

/**
 * The compositor's blend modes are the W3C compositing ones, which 2D
 * canvases implement natively.
 */
const COMPOSITE_OPERATIONS: Record<BlendMode, GlobalCompositeOperation> = {
	normal: "source-over",
	darken: "darken",
	multiply: "multiply",
	"color-burn": "color-burn",
	lighten: "lighten",
	screen: "screen",
	"plus-lighter": "lighter",
	"color-dodge": "color-dodge",
	overlay: "overlay",
	"soft-light": "soft-light",
	"hard-light": "hard-light",
	difference: "difference",
	exclusion: "exclusion",
	hue: "hue",
	saturation: "saturation",
	color: "color",
	luminosity: "luminosity",
};

interface RenderedEntry {
	canvas: OffscreenCanvas;
	contentHash: string;
}

/**
 * Composites frames with a 2D canvas instead of the GPU compositor, for
 * frames made only of placed, faded and blended layers with hard-edged
 * masks — which is nearly every frame of a typical edit.
 *
 * Export reads every frame back from the GPU to encode it. For such frames
 * the GPU round trip (upload each source, render each layer and blend into a
 * full-size target, read back) costs several times more than drawing the
 * sources straight onto the canvas the encoder reads, especially where
 * WebGPU is unavailable (Firefox) and WebGL is used instead.
 *
 * Output matches the GPU compositor: same transform, opacity and blend math,
 * and masks use their alpha.
 */
export class Canvas2dCompositor {
	private rendered = new Map<string, RenderedEntry>();
	private layerCanvas: OffscreenCanvas | null = null;

	/** Whether `render` reproduces what the GPU compositor would draw. */
	static supports({ frame }: { frame: FrameDescriptor }): boolean {
		return frame.items.every(
			(item) =>
				item.type === "layer" &&
				item.effectPassGroups.every((group) => group.length === 0) &&
				(item.mask === null || item.mask.feather === 0),
		);
	}

	render({
		frame,
		textures,
		ctx,
	}: {
		frame: FrameDescriptor;
		textures: TextureUploadDescriptor[];
		ctx: OffscreenCanvasRenderingContext2D;
	}): void {
		const byId = new Map(textures.map((texture) => [texture.id, texture]));
		this.releaseUnused({ byId });

		resetContext({ ctx });
		const [r, g, b, a] = frame.clear.color;
		ctx.clearRect(0, 0, frame.width, frame.height);
		ctx.fillStyle = `rgba(${r * 255}, ${g * 255}, ${b * 255}, ${a})`;
		ctx.fillRect(0, 0, frame.width, frame.height);

		for (const item of frame.items) {
			if (item.type !== "layer") continue;
			const source = this.resolveSource({ id: item.textureId, byId });
			if (!source) continue;

			if (item.mask) {
				const mask = this.resolveSource({ id: item.mask.textureId, byId });
				const layer = this.drawMaskedLayer({ item, source, mask, frame });
				resetContext({ ctx });
				ctx.globalCompositeOperation = COMPOSITE_OPERATIONS[item.blendMode];
				ctx.drawImage(layer, 0, 0);
			} else {
				resetContext({ ctx });
				ctx.globalAlpha = item.opacity;
				ctx.globalCompositeOperation = COMPOSITE_OPERATIONS[item.blendMode];
				drawTransformed({ ctx, item, source });
			}
		}
		resetContext({ ctx });
	}

	private drawMaskedLayer({
		item,
		source,
		mask,
		frame,
	}: {
		item: LayerItem;
		source: CanvasImageSource;
		mask: CanvasImageSource | null;
		frame: FrameDescriptor;
	}): OffscreenCanvas {
		if (
			!this.layerCanvas ||
			this.layerCanvas.width !== frame.width ||
			this.layerCanvas.height !== frame.height
		) {
			this.layerCanvas = new OffscreenCanvas(frame.width, frame.height);
		}
		const layerCtx = this.layerCanvas.getContext("2d");
		if (!layerCtx) {
			throw new Error("Failed to get 2d context for masked layer");
		}
		resetContext({ ctx: layerCtx });
		layerCtx.clearRect(0, 0, frame.width, frame.height);
		layerCtx.globalAlpha = item.opacity;
		drawTransformed({ ctx: layerCtx, item, source });

		// Masks cover the whole canvas, sampled by position like the GPU does.
		resetContext({ ctx: layerCtx });
		if (mask) {
			layerCtx.globalCompositeOperation = item.mask?.inverted
				? "destination-out"
				: "destination-in";
			layerCtx.drawImage(mask, 0, 0, frame.width, frame.height);
		} else if (!item.mask?.inverted) {
			// A missing mask hides the layer, as an empty mask texture would.
			layerCtx.clearRect(0, 0, frame.width, frame.height);
		}
		resetContext({ ctx: layerCtx });
		return this.layerCanvas;
	}

	private resolveSource({
		id,
		byId,
	}: {
		id: string;
		byId: Map<string, TextureUploadDescriptor>;
	}): CanvasImageSource | null {
		const texture = byId.get(id);
		if (!texture) return null;
		if (texture.kind === "external") return texture.source;

		const previous = this.rendered.get(id);
		if (
			previous &&
			previous.contentHash === texture.contentHash &&
			previous.canvas.width === texture.width &&
			previous.canvas.height === texture.height
		) {
			return previous.canvas;
		}

		const canvas =
			previous &&
			previous.canvas.width === texture.width &&
			previous.canvas.height === texture.height
				? previous.canvas
				: new OffscreenCanvas(texture.width, texture.height);
		const textureCtx = canvas.getContext("2d");
		if (!textureCtx) {
			throw new Error(`Failed to get 2d context for texture ${id}`);
		}
		resetContext({ ctx: textureCtx });
		textureCtx.clearRect(0, 0, texture.width, texture.height);
		textureCtx.save();
		texture.draw(textureCtx);
		textureCtx.restore();
		this.rendered.set(id, { canvas, contentHash: texture.contentHash });
		return canvas;
	}

	private releaseUnused({
		byId,
	}: {
		byId: Map<string, TextureUploadDescriptor>;
	}): void {
		for (const id of this.rendered.keys()) {
			if (!byId.has(id)) {
				this.rendered.delete(id);
			}
		}
	}
}

function resetContext({
	ctx,
}: {
	ctx: OffscreenCanvasRenderingContext2D;
}): void {
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = "source-over";
	ctx.filter = "none";
}

/** Same placement as the GPU layer shader: centered, rotated, then flipped. */
function drawTransformed({
	ctx,
	item,
	source,
}: {
	ctx: OffscreenCanvasRenderingContext2D;
	item: LayerItem;
	source: CanvasImageSource;
}): void {
	const { centerX, centerY, width, height, rotationDegrees, flipX, flipY } =
		item.transform;
	ctx.translate(centerX, centerY);
	if (rotationDegrees !== 0) {
		ctx.rotate((rotationDegrees * Math.PI) / 180);
	}
	if (flipX || flipY) {
		ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
	}
	ctx.drawImage(source, -width / 2, -height / 2, width, height);
}
