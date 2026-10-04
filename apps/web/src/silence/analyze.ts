import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import type { MediaAsset } from "@/media/types";
import { getSourceSpanAtClipTime } from "@/retime";
import type { AudioElement, VideoElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { LEVEL_WINDOW_SECONDS, LevelMeter, SILENT_LEVEL_DB } from "./detect";

export type SilenceTargetElement = VideoElement | AudioElement;

/** Progress is reported at most this often; every chunk would flood React. */
const PROGRESS_INTERVAL_MS = 100;

export interface ClipLevels {
	levels: number[];
	/** Seconds of source audio the levels cover. */
	duration: number;
}

export class NoAudioError extends Error {
	constructor() {
		super("This clip has no audio to analyse.");
		this.name = "NoAudioError";
	}
}

async function getSourceBlob({
	element,
	mediaAssets,
	signal,
}: {
	element: SilenceTargetElement;
	mediaAssets: MediaAsset[];
	signal?: AbortSignal;
}): Promise<Blob> {
	if (element.type === "audio" && element.sourceType === "library") {
		const response = await fetch(element.sourceUrl, { signal });
		if (!response.ok) {
			throw new Error(`Could not load the sound (${response.status}).`);
		}
		return response.blob();
	}

	const asset = mediaAssets.find((candidate) => candidate.id === element.mediaId);
	if (!asset) {
		throw new Error("The clip's media is missing.");
	}
	return asset.file;
}

/**
 * Measures the loudness of the part of the source a clip plays, streaming
 * the audio so even hour-long files stay cheap on memory.
 */
export async function measureClipLevels({
	element,
	mediaAssets,
	onProgress,
	signal,
}: {
	element: SilenceTargetElement;
	mediaAssets: MediaAsset[];
	onProgress?: (progress: number) => void;
	signal?: AbortSignal;
}): Promise<ClipLevels> {
	const blob = await getSourceBlob({ element, mediaAssets, signal });
	const sourceStart = element.trimStart / TICKS_PER_SECOND;
	const sourceDuration =
		getSourceSpanAtClipTime({
			clipTime: element.duration,
			retime: element.retime,
		}) / TICKS_PER_SECOND;
	const sourceEnd = sourceStart + sourceDuration;

	const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			throw new NoAudioError();
		}

		const sampleRate = audioTrack.sampleRate;
		const meter = new LevelMeter({ sampleRate });
		const sink = new AudioBufferSink(audioTrack);
		let measuredSamples = 0;
		let lastProgressAt = 0;
		const totalSamples = Math.round(sourceDuration * sampleRate);

		for await (const { buffer, timestamp } of sink.buffers(sourceStart, sourceEnd)) {
			signal?.throwIfAborted();

			// Chunks straddle the clip's edges; keep only the samples inside it.
			const skip = Math.max(0, Math.round((sourceStart - timestamp) * sampleRate));
			const available = Math.max(0, buffer.length - skip);
			const length = Math.min(available, totalSamples - measuredSamples);
			if (length <= 0) {
				continue;
			}

			const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
				buffer.getChannelData(channel).subarray(skip, skip + length),
			);
			meter.push({ channels });
			measuredSamples += length;
			const now = performance.now();
			if (onProgress && now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
				lastProgressAt = now;
				onProgress(Math.min(1, measuredSamples / Math.max(1, totalSamples)));
			}

			if (measuredSamples >= totalSamples) {
				break;
			}
		}

		// Audio that ends before the clip does leaves the rest silent.
		const levels = meter.finish();
		const expectedWindows = Math.ceil(sourceDuration / LEVEL_WINDOW_SECONDS);
		while (levels.length < expectedWindows) {
			levels.push(SILENT_LEVEL_DB);
		}
		return { levels, duration: sourceDuration };
	} finally {
		input.dispose();
	}
}
