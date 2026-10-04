/** Length of each loudness measurement. */
export const LEVEL_WINDOW_SECONDS = 0.02;

/** Below this, a window is treated as digital silence. */
export const SILENT_LEVEL_DB = -100;

export interface SilenceSettings {
	/** Windows quieter than this (dBFS) count as silent. */
	thresholdDb: number;
	/** Silent stretches shorter than this are kept, e.g. pauses between words. */
	minSilenceSeconds: number;
	/** Audio kept on each side of the sound next to a removed stretch. */
	paddingSeconds: number;
}

export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = {
	thresholdDb: -40,
	minSilenceSeconds: 0.5,
	paddingSeconds: 0.1,
};

export interface TimeRange {
	start: number;
	end: number;
}

export interface SilenceAnalysis {
	/** Seconds of audio analysed, from the start of the levels. */
	duration: number;
	/** Parts to keep, in seconds from the start of the levels. */
	keep: TimeRange[];
	/** Parts to remove. */
	silent: TimeRange[];
}

/**
 * Collects the loudness (RMS, in dBFS) of consecutive fixed-length windows
 * from audio delivered in arbitrary chunks.
 */
export class LevelMeter {
	readonly windowSize: number;
	private levels: number[] = [];
	private sumOfSquares = 0;
	private filled = 0;

	constructor({ sampleRate }: { sampleRate: number }) {
		this.windowSize = Math.max(1, Math.round(sampleRate * LEVEL_WINDOW_SECONDS));
	}

	/**
	 * `channels` are equally long. A window's level is the average power
	 * across channels, so out-of-phase stereo does not cancel to silence.
	 */
	push({ channels }: { channels: Float32Array[] }): void {
		const channelCount = channels.length;
		if (channelCount === 0) {
			return;
		}
		const length = channels[0].length;
		let offset = 0;
		while (offset < length) {
			const take = Math.min(this.windowSize - this.filled, length - offset);
			const end = offset + take;
			let sum = 0;
			for (let channel = 0; channel < channelCount; channel++) {
				const data = channels[channel];
				for (let index = offset; index < end; index++) {
					const sample = data[index];
					sum += sample * sample;
				}
			}
			this.sumOfSquares += sum / channelCount;
			this.filled += take;
			offset = end;
			if (this.filled === this.windowSize) {
				this.flushWindow();
			}
		}
	}

	/** Levels for every full window plus the trailing partial one. */
	finish(): number[] {
		if (this.filled > 0) {
			this.flushWindow();
		}
		return this.levels;
	}

	private flushWindow(): void {
		const rms = Math.sqrt(this.sumOfSquares / this.filled);
		this.levels.push(rms > 0 ? Math.max(SILENT_LEVEL_DB, 20 * Math.log10(rms)) : SILENT_LEVEL_DB);
		this.sumOfSquares = 0;
		this.filled = 0;
	}
}

/**
 * Splits audio into parts to keep and silent parts to remove.
 *
 * A stretch is removed only when it stays below the threshold for at least
 * `minSilenceSeconds`; it is then shrunk by `paddingSeconds` on each side
 * that borders sound, so speech is not clipped.
 */
export function findSilence({
	levels,
	duration,
	settings,
	windowSeconds = LEVEL_WINDOW_SECONDS,
}: {
	levels: number[];
	duration: number;
	settings: SilenceSettings;
	windowSeconds?: number;
}): SilenceAnalysis {
	const silent: TimeRange[] = [];
	let runStart: number | null = null;

	const closeRun = (endIndex: number) => {
		if (runStart === null) {
			return;
		}
		const rawStart = runStart * windowSeconds;
		const rawEnd = Math.min(duration, endIndex * windowSeconds);
		runStart = null;
		if (rawEnd - rawStart < settings.minSilenceSeconds) {
			return;
		}
		// Clip edges have no sound to protect, so no padding there.
		const start = rawStart <= 0 ? 0 : rawStart + settings.paddingSeconds;
		const end = rawEnd >= duration ? duration : rawEnd - settings.paddingSeconds;
		if (end - start > 0) {
			silent.push({ start, end });
		}
	};

	for (let index = 0; index < levels.length; index++) {
		if (levels[index] < settings.thresholdDb) {
			runStart ??= index;
		} else {
			closeRun(index);
		}
	}
	closeRun(levels.length);

	return { duration, silent, keep: invertRanges({ ranges: silent, duration }) };
}

function invertRanges({
	ranges,
	duration,
}: {
	ranges: TimeRange[];
	duration: number;
}): TimeRange[] {
	const keep: TimeRange[] = [];
	let cursor = 0;
	for (const range of ranges) {
		if (range.start > cursor) {
			keep.push({ start: cursor, end: range.start });
		}
		cursor = Math.max(cursor, range.end);
	}
	if (cursor < duration) {
		keep.push({ start: cursor, end: duration });
	}
	return keep;
}

export function totalRangeLength({ ranges }: { ranges: TimeRange[] }): number {
	return ranges.reduce((total, range) => total + (range.end - range.start), 0);
}
