import type { ParamValues } from "@/params";
import {
	resolveTransitionFrame,
	type TransitionLayerState,
} from "@/transitions";
import { createCanvasSurface } from "./canvas-utils";
import {
	applyTransitionTransform,
	drawPerspectiveLayer,
} from "./compositor/transition-layer";
import type { QuadTransformDescriptor } from "./compositor/types";

type PreviewContext =
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D;

const sampleCache = new Map<string, OffscreenCanvas>();

function getSampleFrame({
	label,
	colors,
	width,
	height,
}: {
	label: string;
	colors: [string, string];
	width: number;
	height: number;
}): OffscreenCanvas {
	const key = `${label}:${width}x${height}`;
	const cached = sampleCache.get(key);
	if (cached) {
		return cached;
	}

	const { canvas, context } = createCanvasSurface({ width, height });
	const gradient = context.createLinearGradient(0, 0, width, height);
	gradient.addColorStop(0, colors[0]);
	gradient.addColorStop(1, colors[1]);
	context.fillStyle = gradient;
	context.fillRect(0, 0, width, height);
	context.fillStyle = "rgba(255, 255, 255, 0.92)";
	context.font = `600 ${Math.round(height * 0.42)}px sans-serif`;
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillText(label, width / 2, height / 2);
	sampleCache.set(key, canvas);
	return canvas;
}

function drawPreviewLayer({
	ctx,
	source,
	state,
	width,
	height,
}: {
	ctx: PreviewContext;
	source: OffscreenCanvas;
	state: TransitionLayerState;
	width: number;
	height: number;
}) {
	const opacity = state.opacity ?? 1;
	if (opacity <= 0) {
		return;
	}

	const fullFrame: QuadTransformDescriptor = {
		centerX: width / 2,
		centerY: height / 2,
		width,
		height,
		rotationDegrees: 0,
		flipX: false,
		flipY: false,
	};
	const transform = applyTransitionTransform({ transform: fullFrame, state });
	if (transform.width < 0.5 || transform.height < 0.5) {
		return;
	}

	const { canvas: layer, context: layerCtx } = createCanvasSurface({
		width,
		height,
	});
	if (state.rotateY) {
		drawPerspectiveLayer({
			ctx: layerCtx,
			source,
			sourceWidth: width,
			sourceHeight: height,
			transform,
			rotateY: state.rotateY,
		});
	} else {
		layerCtx.translate(transform.centerX, transform.centerY);
		layerCtx.rotate((transform.rotationDegrees * Math.PI) / 180);
		layerCtx.drawImage(
			source,
			-transform.width / 2,
			-transform.height / 2,
			transform.width,
			transform.height,
		);
		layerCtx.setTransform(1, 0, 0, 1, 0, 0);
	}

	if (state.clip) {
		const { canvas: clipCanvas, context: clipCtx } = createCanvasSurface({
			width,
			height,
		});
		state.clip.draw({ ctx: clipCtx, width, height });
		layerCtx.globalCompositeOperation = "destination-in";
		layerCtx.drawImage(clipCanvas, 0, 0);
	}

	ctx.save();
	ctx.globalAlpha = opacity;
	if (state.blur && state.blur > 0) {
		ctx.filter = `blur(${state.blur}px)`;
	}
	ctx.drawImage(layer, 0, 0);
	ctx.restore();
}

/** Draws one frame of a transition between two sample cards. */
export function drawTransitionPreview({
	ctx,
	type,
	params = {},
	progress,
	width,
	height,
}: {
	ctx: PreviewContext;
	type: string;
	params?: ParamValues;
	progress: number;
	width: number;
	height: number;
}): void {
	ctx.clearRect(0, 0, width, height);
	ctx.fillStyle = "#000000";
	ctx.fillRect(0, 0, width, height);

	const frame = resolveTransitionFrame({
		type,
		params,
		progress,
		width,
		height,
	});
	if (!frame) {
		return;
	}

	drawPreviewLayer({
		ctx,
		source: getSampleFrame({
			label: "A",
			colors: ["#2563eb", "#7c3aed"],
			width,
			height,
		}),
		state: frame.from,
		width,
		height,
	});
	drawPreviewLayer({
		ctx,
		source: getSampleFrame({
			label: "B",
			colors: ["#f97316", "#e11d48"],
			width,
			height,
		}),
		state: frame.to,
		width,
		height,
	});

	if (frame.overlay && frame.overlay.opacity > 0) {
		ctx.save();
		ctx.globalAlpha = frame.overlay.opacity;
		ctx.fillStyle = frame.overlay.color;
		ctx.fillRect(0, 0, width, height);
		ctx.restore();
	}
}
