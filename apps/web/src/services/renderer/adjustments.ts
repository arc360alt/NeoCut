import { buildAdjustmentFilter, type Adjustments } from "@/adjustments";
import { createCanvasSurface } from "./canvas-utils";

type AdjustmentContext =
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D;

const WARM_COLOR = "#ff9a2e";
const COOL_COLOR = "#2e8bff";
const MAGENTA_COLOR = "#ff2ed1";
const GREEN_COLOR = "#2eff6a";
/** Opacity of the soft-light tint at ±100. */
const MAX_TINT_STRENGTH = 0.65;
const MAX_VIGNETTE_OPACITY = 0.85;

let canvasFilterSupport: boolean | null = null;

/** Safari only gained `CanvasRenderingContext2D.filter` recently. */
function supportsCanvasFilter(): boolean {
	if (canvasFilterSupport === null) {
		const { context } = createCanvasSurface({ width: 1, height: 1 });
		canvasFilterSupport = typeof context.filter === "string";
	}
	return canvasFilterSupport;
}

type ColorMatrix = number[];

const IDENTITY_MATRIX: ColorMatrix = [
	1, 0, 0, 0, 0,
	0, 1, 0, 0, 0,
	0, 0, 1, 0, 0,
];

/** 3x3 color matrix plus a per-channel offset in 0..1 space (row-major 3x5). */
function multiplyColorMatrices({
	left,
	right,
}: {
	left: ColorMatrix;
	right: ColorMatrix;
}): ColorMatrix {
	const result: ColorMatrix = [];
	for (let row = 0; row < 3; row++) {
		for (let column = 0; column < 4; column++) {
			let value = 0;
			for (let index = 0; index < 3; index++) {
				value += left[row * 5 + index] * right[index * 5 + column];
			}
			result.push(value);
		}
		let offset = left[row * 5 + 4];
		for (let index = 0; index < 3; index++) {
			offset += left[row * 5 + index] * right[index * 5 + 4];
		}
		result.push(offset);
	}
	return result.map((value, index) =>
		index % 5 === 3 ? 0 : value,
	);
}

/** Fallback for browsers without canvas filters; same matrices as the CSS filter spec. */
export function buildAdjustmentColorMatrix({
	adjustments,
}: {
	adjustments: Adjustments;
}): ColorMatrix {
	let matrix = IDENTITY_MATRIX;
	const apply = (next: ColorMatrix) => {
		matrix = multiplyColorMatrices({ left: next, right: matrix });
	};

	if (adjustments.brightness !== 0) {
		const b = Math.max(0, 1 + adjustments.brightness / 100);
		apply([b, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, b, 0, 0]);
	}
	if (adjustments.contrast !== 0) {
		const c = Math.max(0, 1 + adjustments.contrast / 100);
		const offset = 0.5 - 0.5 * c;
		apply([c, 0, 0, 0, offset, 0, c, 0, 0, offset, 0, 0, c, 0, offset]);
	}
	if (adjustments.saturation !== 0) {
		const s = Math.max(0, 1 + adjustments.saturation / 100);
		apply([
			0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
			0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
			0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
		]);
	}
	if (adjustments.hue !== 0) {
		const angle = (adjustments.hue * Math.PI) / 180;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		apply([
			0.213 + cos * 0.787 - sin * 0.213,
			0.715 - cos * 0.715 - sin * 0.715,
			0.072 - cos * 0.072 + sin * 0.928,
			0,
			0,
			0.213 - cos * 0.213 + sin * 0.143,
			0.715 + cos * 0.285 + sin * 0.14,
			0.072 - cos * 0.072 - sin * 0.283,
			0,
			0,
			0.213 - cos * 0.213 - sin * 0.787,
			0.715 - cos * 0.715 + sin * 0.715,
			0.072 + cos * 0.928 + sin * 0.072,
			0,
			0,
		]);
	}
	return matrix;
}

function applyColorMatrixFallback({
	ctx,
	width,
	height,
	adjustments,
}: {
	ctx: AdjustmentContext;
	width: number;
	height: number;
	adjustments: Adjustments;
}) {
	const matrix = buildAdjustmentColorMatrix({ adjustments });
	const image = ctx.getImageData(0, 0, width, height);
	const data = image.data;
	for (let index = 0; index < data.length; index += 4) {
		const r = data[index] / 255;
		const g = data[index + 1] / 255;
		const b = data[index + 2] / 255;
		data[index] =
			(matrix[0] * r + matrix[1] * g + matrix[2] * b + matrix[4]) * 255;
		data[index + 1] =
			(matrix[5] * r + matrix[6] * g + matrix[7] * b + matrix[9]) * 255;
		data[index + 2] =
			(matrix[10] * r + matrix[11] * g + matrix[12] * b + matrix[14]) * 255;
	}
	ctx.putImageData(image, 0, 0);
}

function applySoftLightTint({
	ctx,
	source,
	width,
	height,
	color,
	amount,
}: {
	ctx: AdjustmentContext;
	source: CanvasImageSource;
	width: number;
	height: number;
	color: string;
	amount: number;
}) {
	ctx.save();
	ctx.globalCompositeOperation = "soft-light";
	ctx.globalAlpha = Math.min(1, Math.abs(amount) / 100) * MAX_TINT_STRENGTH;
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, width, height);
	// Blending also paints transparent pixels; cut back to the source's shape.
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = "destination-in";
	ctx.drawImage(source, 0, 0, width, height);
	ctx.restore();
}

function applyVignette({
	ctx,
	width,
	height,
	amount,
}: {
	ctx: AdjustmentContext;
	width: number;
	height: number;
	amount: number;
}) {
	const strength = Math.min(1, amount / 100);
	const centerX = width / 2;
	const centerY = height / 2;
	const radius = Math.hypot(width, height) / 2;
	const gradient = ctx.createRadialGradient(
		centerX,
		centerY,
		radius * (0.75 - 0.4 * strength),
		centerX,
		centerY,
		radius,
	);
	gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
	gradient.addColorStop(1, `rgba(0, 0, 0, ${MAX_VIGNETTE_OPACITY * strength})`);
	ctx.save();
	ctx.globalCompositeOperation = "source-atop";
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, width, height);
	ctx.restore();
}

/**
 * Draws `source` stretched to `width`x`height` with the color adjustments
 * applied. Blur is not handled here; it runs on the GPU.
 */
export function drawAdjustedSource({
	ctx,
	source,
	width,
	height,
	adjustments,
}: {
	ctx: AdjustmentContext;
	source: CanvasImageSource;
	width: number;
	height: number;
	adjustments: Adjustments;
}): void {
	const filter = buildAdjustmentFilter({ adjustments });
	const useCanvasFilter = filter !== "none" && supportsCanvasFilter();

	ctx.save();
	if (useCanvasFilter) {
		ctx.filter = filter;
	}
	ctx.drawImage(source, 0, 0, width, height);
	ctx.restore();

	if (filter !== "none" && !useCanvasFilter) {
		applyColorMatrixFallback({ ctx, width, height, adjustments });
	}
	if (adjustments.temperature !== 0) {
		applySoftLightTint({
			ctx,
			source,
			width,
			height,
			color: adjustments.temperature > 0 ? WARM_COLOR : COOL_COLOR,
			amount: adjustments.temperature,
		});
	}
	if (adjustments.tint !== 0) {
		applySoftLightTint({
			ctx,
			source,
			width,
			height,
			color: adjustments.tint > 0 ? MAGENTA_COLOR : GREEN_COLOR,
			amount: adjustments.tint,
		});
	}
	if (adjustments.vignette > 0) {
		applyVignette({ ctx, width, height, amount: adjustments.vignette });
	}
}

/** Same as `drawAdjustedSource`, into a new canvas. */
export function renderAdjustedSource({
	source,
	width,
	height,
	adjustments,
}: {
	source: CanvasImageSource;
	width: number;
	height: number;
	adjustments: Adjustments;
}): OffscreenCanvas {
	const { canvas, context } = createCanvasSurface({ width, height });
	drawAdjustedSource({ ctx: context, source, width, height, adjustments });
	return canvas;
}
