/**
 * Renders vector images (SVG files, stickers) at the size they are shown.
 *
 * An SVG's "natural" size is whatever width/height its file declares (often
 * 100–300 px), so drawing that bitmap scaled up to fill the frame is blurry.
 * Drawing the SVG `<img>` into a canvas at a larger size re-renders the
 * vector instead, so it stays sharp at any scale.
 */

const MIN_RASTER_SIZE = 256;
/** 4096² RGBA is 64 MB; larger isn't worth it for an overlay. */
const MAX_RASTER_SIZE = 4096;
/** Sizes kept per image, so zooming back and forth doesn't re-render. */
const SIZES_PER_IMAGE = 2;
/** Used when an SVG declares no size (Firefox then reports 0). */
const FALLBACK_INTRINSIC_SIZE = 512;

export interface RasterizedVector {
	source: OffscreenCanvas;
	width: number;
	height: number;
}

const rasterCache = new Map<string, Map<number, RasterizedVector>>();

export function isVectorUrl({ url }: { url: string }): boolean {
	return /^data:image\/svg\+xml/i.test(url) || /\.svg(?:[?#]|$)/i.test(url);
}

/** The image's own size, with a fallback for SVGs that declare none. */
export function intrinsicVectorSize({
	image,
}: {
	image: HTMLImageElement;
}): { width: number; height: number } {
	const width = image.naturalWidth || FALLBACK_INTRINSIC_SIZE;
	const height = image.naturalHeight || FALLBACK_INTRINSIC_SIZE;
	return { width, height };
}

/**
 * The longest side, in pixels, worth rasterizing at: the displayed size
 * rounded up to a power of two, so small scale changes reuse one raster.
 */
export function vectorRasterSize({ displayedLongSide }: { displayedLongSide: number }): number {
	const target = Math.max(MIN_RASTER_SIZE, Math.min(MAX_RASTER_SIZE, displayedLongSide));
	return Math.min(MAX_RASTER_SIZE, 2 ** Math.ceil(Math.log2(target)));
}

export function rasterizeVector({
	cacheKey,
	image,
	intrinsicWidth,
	intrinsicHeight,
	longSide,
}: {
	cacheKey: string;
	image: HTMLImageElement;
	intrinsicWidth: number;
	intrinsicHeight: number;
	longSide: number;
}): RasterizedVector | null {
	let sizes = rasterCache.get(cacheKey);
	const cached = sizes?.get(longSide);
	if (cached) {
		// Most recently used last, so eviction drops the stalest size.
		sizes?.delete(longSide);
		sizes?.set(longSide, cached);
		return cached;
	}

	const scale = longSide / Math.max(intrinsicWidth, intrinsicHeight);
	const width = Math.max(1, Math.round(intrinsicWidth * scale));
	const height = Math.max(1, Math.round(intrinsicHeight * scale));
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) {
		return null;
	}
	context.drawImage(image, 0, 0, width, height);

	const raster = { source: canvas, width, height };
	if (!sizes) {
		sizes = new Map();
		rasterCache.set(cacheKey, sizes);
	}
	sizes.set(longSide, raster);
	while (sizes.size > SIZES_PER_IMAGE) {
		const oldest = sizes.keys().next().value;
		if (oldest === undefined) break;
		sizes.delete(oldest);
	}
	return raster;
}

/** Longest displayed side of a source fitted into the canvas, then scaled. */
export function displayedLongSide({
	sourceWidth,
	sourceHeight,
	canvasWidth,
	canvasHeight,
	scaleX,
	scaleY,
	sourceSizeLimit,
}: {
	sourceWidth: number;
	sourceHeight: number;
	canvasWidth: number;
	canvasHeight: number;
	scaleX: number;
	scaleY: number;
	/** The preview's on-screen size cap; null for export (full size). */
	sourceSizeLimit: number | null;
}): number {
	const containScale = Math.min(canvasWidth / sourceWidth, canvasHeight / sourceHeight);
	const longSide =
		Math.max(sourceWidth, sourceHeight) *
		containScale *
		Math.max(Math.abs(scaleX), Math.abs(scaleY));
	// The preview is shown smaller than the canvas; don't render past that.
	const previewRatio =
		sourceSizeLimit === null
			? 1
			: Math.min(1, sourceSizeLimit / Math.max(canvasWidth, canvasHeight));
	return longSide * previewRatio;
}
