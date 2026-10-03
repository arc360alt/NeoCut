/**
 * Decode sizes (longest side, in pixels) the preview steps through. Rounding
 * up to a step keeps small panel resizes from restarting video decoders.
 */
const PREVIEW_SOURCE_SIZE_STEPS = [640, 960, 1280, 1920, 2560, 3840];

/**
 * Used until the preview has been measured. Falling back to full resolution
 * here would open a full-size decoder for every video on the first frame.
 */
const UNMEASURED_PREVIEW_SOURCE_SIZE = 1280;

/**
 * The largest video frame worth decoding for a preview shown at
 * `displayWidth` x `displayHeight` CSS pixels. Null means full resolution.
 */
export function getPreviewSourceSizeLimit({
	displayWidth,
	displayHeight,
	devicePixelRatio,
}: {
	displayWidth: number;
	displayHeight: number;
	devicePixelRatio: number;
}): number | null {
	const longEdge =
		Math.max(displayWidth, displayHeight) * Math.max(1, devicePixelRatio);
	if (!Number.isFinite(longEdge) || longEdge <= 0) {
		return UNMEASURED_PREVIEW_SOURCE_SIZE;
	}
	return PREVIEW_SOURCE_SIZE_STEPS.find((step) => step >= longEdge) ?? null;
}
