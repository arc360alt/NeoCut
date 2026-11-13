import type { FrameRate } from "opencut-wasm";
import type { MediaAsset } from "@/media/types";

type MediaAssetFpsInput = Pick<MediaAsset, "type" | "fps">;

const STANDARD_FRAME_RATES: Array<{ value: number; rate: FrameRate }> = [
	{ value: 24_000 / 1_001, rate: { numerator: 24_000, denominator: 1_001 } },
	{ value: 24, rate: { numerator: 24, denominator: 1 } },
	{ value: 25, rate: { numerator: 25, denominator: 1 } },
	{ value: 30_000 / 1_001, rate: { numerator: 30_000, denominator: 1_001 } },
	{ value: 30, rate: { numerator: 30, denominator: 1 } },
	{ value: 48, rate: { numerator: 48, denominator: 1 } },
	{ value: 50, rate: { numerator: 50, denominator: 1 } },
	{ value: 60_000 / 1_001, rate: { numerator: 60_000, denominator: 1_001 } },
	{ value: 60, rate: { numerator: 60, denominator: 1 } },
	{ value: 120, rate: { numerator: 120, denominator: 1 } },
];

const STANDARD_FRAME_RATE_TOLERANCE = 0.01;

/** Rates a project snaps to when it takes its rate from imported media. */
const PROJECT_FRAME_RATES = [24, 25, 30, 50, 60, 120];

/**
 * The project rate for media measured at `fps`. Screen and phone recordings
 * often have a variable rate whose average is something like 34.6; exporting
 * at 35 fps makes files that phone apps and upload sites fail to process
 * ("Failed to resize video"), so anything that isn't already a standard rate
 * snaps to the nearest common one.
 */
export function projectFrameRateForMedia(fps: number): FrameRate {
	const standard = STANDARD_FRAME_RATES.find(
		(candidate) => Math.abs(fps - candidate.value) <= STANDARD_FRAME_RATE_TOLERANCE,
	);
	if (standard) return standard.rate;
	const nearest = PROJECT_FRAME_RATES.reduce((best, candidate) =>
		Math.abs(candidate - fps) < Math.abs(best - fps) ? candidate : best,
	);
	return { numerator: nearest, denominator: 1 };
}

export function frameRateToFloat(rate: FrameRate): number {
	return rate.numerator / rate.denominator;
}

export function frameRatesEqual({
	a,
	b,
}: {
	a: FrameRate;
	b: FrameRate;
}): boolean {
	return a.numerator === b.numerator && a.denominator === b.denominator;
}

export function floatToFrameRate(fps: number): FrameRate {
	const standard = STANDARD_FRAME_RATES.find(
		(candidate) => Math.abs(fps - candidate.value) <= STANDARD_FRAME_RATE_TOLERANCE,
	);
	if (standard) return standard.rate;

	if (Number.isInteger(fps)) {
		return { numerator: fps, denominator: 1 };
	}

	const ARBITRARY_DENOMINATOR = 1_000_000;
	const scaledNumerator = Math.round(fps * ARBITRARY_DENOMINATOR);
	const divisor = gcd({
		left: scaledNumerator,
		right: ARBITRARY_DENOMINATOR,
	});
	return {
		numerator: scaledNumerator / divisor,
		denominator: ARBITRARY_DENOMINATOR / divisor,
	};
}

function gcd({ left, right }: { left: number; right: number }): number {
	let a = Math.abs(left);
	let b = Math.abs(right);
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a || 1;
}

export function getHighestImportedVideoFps({
	mediaAssets,
}: {
	mediaAssets: MediaAssetFpsInput[];
}): number | null {
	let highestFps: number | null = null;

	for (const asset of mediaAssets) {
		const fps = asset.fps ?? Number.NaN;
		if (asset.type !== "video") continue;
		if (!Number.isFinite(fps) || fps <= 0) continue;

		highestFps = highestFps === null ? fps : Math.max(highestFps, fps);
	}

	return highestFps;
}

export function getRaisedProjectFpsForImportedMedia({
	currentFps,
	importedAssets,
}: {
	currentFps: FrameRate;
	importedAssets: MediaAssetFpsInput[];
}): FrameRate | null {
	const highestImportedVideoFps = getHighestImportedVideoFps({
		mediaAssets: importedAssets,
	});

	if (highestImportedVideoFps === null) {
		return null;
	}
	const nextFps = projectFrameRateForMedia(highestImportedVideoFps);
	if (frameRateToFloat(nextFps) <= frameRateToFloat(currentFps)) {
		return null;
	}
	return nextFps;
}
