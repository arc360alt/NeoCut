import { buildGaussianBlurPasses } from "@/effects/definitions/blur";
import type { EffectPass } from "@/effects/types";
import type { TransitionLayerState } from "@/transitions";
import { createCanvasSurface } from "../canvas-utils";
import type {
	LayerMaskDescriptor,
	QuadTransformDescriptor,
	TextureCanvasDrawFn,
	TextureUploadDescriptor,
} from "./types";

/** Vertical slices used to approximate a perspective-projected face. */
const PERSPECTIVE_STRIPS = 96;
/** Camera distance, as a multiple of the face width. */
const PERSPECTIVE_DISTANCE = 2;
/** Slight overlap between slices so no seams show. */
const STRIP_OVERLAP_PX = 0.75;

export function applyTransitionTransform({
	transform,
	state,
}: {
	transform: QuadTransformDescriptor;
	state: TransitionLayerState | null;
}): QuadTransformDescriptor {
	if (!state) {
		return transform;
	}

	const scale = state.scale ?? 1;
	const scaleX = scale * (state.scaleX ?? 1);
	return {
		...transform,
		centerX: transform.centerX + (state.offsetX ?? 0),
		centerY: transform.centerY + (state.offsetY ?? 0),
		width: transform.width * Math.abs(scaleX),
		height: transform.height * Math.abs(scale),
		rotationDegrees: transform.rotationDegrees + (state.rotate ?? 0),
	};
}

export function appendTransitionBlur({
	effectPassGroups,
	state,
}: {
	effectPassGroups: EffectPass[][];
	state: TransitionLayerState | null;
}): EffectPass[][] {
	const sigma = state?.blur ?? 0;
	if (sigma <= 0) {
		return effectPassGroups;
	}
	const passes = buildGaussianBlurPasses({ sigmaX: sigma, sigmaY: sigma });
	return passes.length > 0 ? [...effectPassGroups, passes] : effectPassGroups;
}

/**
 * Intersects the layer's own mask (if any) with the transition's reveal
 * shape, producing a single mask texture.
 */
export function applyTransitionClip({
	mask,
	state,
	path,
	canvasWidth,
	canvasHeight,
	textures,
}: {
	mask: LayerMaskDescriptor | null;
	state: TransitionLayerState | null;
	path: string;
	canvasWidth: number;
	canvasHeight: number;
	textures: Map<string, TextureUploadDescriptor>;
}): LayerMaskDescriptor | null {
	const clip = state?.clip;
	if (!clip) {
		return mask;
	}

	const drawClip: TextureCanvasDrawFn = (ctx) =>
		clip.draw({ ctx, width: canvasWidth, height: canvasHeight });

	const elementMaskTexture = mask ? textures.get(mask.textureId) : undefined;
	if (!mask || !elementMaskTexture || elementMaskTexture.kind !== "rendered") {
		const textureId = `${path}:transition-clip`;
		textures.set(textureId, {
			kind: "rendered",
			id: textureId,
			contentHash: `transition-clip:${clip.key}:${canvasWidth}x${canvasHeight}`,
			width: canvasWidth,
			height: canvasHeight,
			draw: drawClip,
		});
		return { textureId, feather: 0, inverted: false };
	}

	const textureId = `${path}:transition-mask`;
	textures.set(textureId, {
		kind: "rendered",
		id: textureId,
		contentHash: `transition-mask:${elementMaskTexture.contentHash}:inverted=${mask.inverted}:${clip.key}`,
		width: canvasWidth,
		height: canvasHeight,
		draw: (ctx) => {
			elementMaskTexture.draw(ctx);
			ctx.save();
			if (mask.inverted) {
				// The inversion has to happen before intersecting, so bake it in.
				ctx.globalCompositeOperation = "xor";
				ctx.fillStyle = "white";
				ctx.fillRect(0, 0, canvasWidth, canvasHeight);
			}
			const { canvas: clipCanvas, context: clipCtx } = createCanvasSurface({
				width: canvasWidth,
				height: canvasHeight,
			});
			drawClip(clipCtx);
			ctx.globalCompositeOperation = "destination-in";
			ctx.drawImage(clipCanvas, 0, 0);
			ctx.restore();
		},
	});
	textures.delete(mask.textureId);
	return { textureId, feather: mask.feather, inverted: false };
}

/**
 * Draws `source` into `transform`'s rectangle as a face turned around a
 * vertical axis, seen in perspective. The face is cut into thin vertical
 * slices, each scaled by its own depth.
 */
export function drawPerspectiveLayer({
	ctx,
	source,
	sourceWidth,
	sourceHeight,
	transform,
	rotateY,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	source: CanvasImageSource;
	sourceWidth: number;
	sourceHeight: number;
	transform: QuadTransformDescriptor;
	rotateY: NonNullable<TransitionLayerState["rotateY"]>;
}): void {
	const angle = (rotateY.angle * Math.PI) / 180;
	const cos = Math.cos(angle);
	if (cos <= 0.001) {
		return;
	}

	const sin = Math.sin(angle);
	const width = transform.width;
	const height = transform.height;
	const pivot = rotateY.pivotDepth * width;
	const distance = PERSPECTIVE_DISTANCE * width;

	const project = (x: number) => {
		const projectedX = x * cos - pivot * sin;
		const depth = -x * sin - pivot * cos + pivot;
		const scale = distance / Math.max(1, distance + depth);
		return { x: projectedX * scale, scale };
	};

	ctx.save();
	ctx.translate(transform.centerX, transform.centerY);
	ctx.rotate((transform.rotationDegrees * Math.PI) / 180);
	ctx.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);

	const stripWidth = width / PERSPECTIVE_STRIPS;
	const sourceStripWidth = sourceWidth / PERSPECTIVE_STRIPS;
	for (let index = 0; index < PERSPECTIVE_STRIPS; index++) {
		const left = project(-width / 2 + index * stripWidth);
		const right = project(-width / 2 + (index + 1) * stripWidth);
		const destWidth = right.x - left.x;
		if (destWidth <= 0.01) {
			continue;
		}
		const destHeight = (height * (left.scale + right.scale)) / 2;
		ctx.drawImage(
			source,
			index * sourceStripWidth,
			0,
			sourceStripWidth,
			sourceHeight,
			left.x,
			-destHeight / 2,
			destWidth + STRIP_OVERLAP_PX,
			destHeight,
		);
	}

	ctx.restore();
}
