import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	VideoSample,
	VideoSampleSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
	canEncodeAudio,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { CanvasRenderer } from "./canvas-renderer";
import type { TimelineAudioStream } from "@/media/timeline-audio";
import { applyAvcEncoderConfig } from "@/media/avc-encoding";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioStream?: TimelineAudioStream;
	/** Keep alpha (WebM only); frames start transparent instead of black. */
	transparentBackground?: boolean;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

/** Audio is fed to the encoder this far ahead of the video it accompanies. */
const AUDIO_LOOKAHEAD_SECONDS = 1;
const EXPORT_DIRECTORY = "exports";
/** Smallest audio frame the encoders produce (Opus at 48 kHz: 20 ms). */
const MIN_AUDIO_FRAME_SAMPLES = 960;
/** Headroom on the packet counts reserved for the MP4 index. */
const PACKET_COUNT_MARGIN = 64;

/**
 * Where the encoded file is written. Streaming into a file in the origin's
 * private storage keeps memory flat: a long export can be several GB, which
 * would not fit in RAM (and downloading an in-memory file copies it again).
 */
async function createExportTarget({
	extension,
}: {
	extension: string;
}): Promise<{
	target: BufferTarget | StreamTarget;
	getResult: () => Promise<Blob | null>;
	discard: () => Promise<void>;
}> {
	try {
		const root = await navigator.storage.getDirectory();
		const directory = await root.getDirectoryHandle(EXPORT_DIRECTORY, {
			create: true,
		});
		// Previous exports have been downloaded by now; free their disk space.
		for await (const name of directory.keys()) {
			await directory.removeEntry(name).catch(() => {});
		}
		const name = `export-${Date.now()}${extension}`;
		const handle = await directory.getFileHandle(name, { create: true });
		const writable = await handle.createWritable();
		return {
			target: new StreamTarget(writable, { chunked: true }),
			getResult: () => handle.getFile(),
			discard: () => directory.removeEntry(name).catch(() => {}),
		};
	} catch (error) {
		console.warn("Streaming export unavailable, exporting in memory:", error);
		const target = new BufferTarget();
		return {
			target,
			getResult: async () =>
				target.buffer ? new Blob([target.buffer]) : null,
			discard: async () => {},
		};
	}
}

/**
 * Wraps a rendered frame for the encoder. A decoded video frame passed
 * through as is gets a re-timed reference to the same pixels (a sample owns,
 * and closes, the frame it wraps, and the decoder's frame stays cached).
 */
function createFrameSample({
	source,
	timestamp,
	duration,
}: {
	source: CanvasImageSource;
	timestamp: number;
	duration: number;
}): VideoSample {
	if (typeof VideoFrame !== "undefined" && source instanceof VideoFrame) {
		const frame = new VideoFrame(source, {
			timestamp: Math.round(timestamp * 1e6),
			duration: Math.round(duration * 1e6),
		});
		return new VideoSample(frame, { timestamp, duration });
	}
	return new VideoSample(source, { timestamp, duration });
}

let aacEncoderReady: Promise<void> | null = null;

/** Registers the bundled AAC encoder when the browser has no native one. */
function ensureAacEncoder(): Promise<void> {
	aacEncoderReady ??= (async () => {
		if (await canEncodeAudio("aac")) return;
		const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
		registerAacEncoder();
	})();
	return aacEncoderReady;
}

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [file: Blob];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioStream?: TimelineAudioStream;
	private transparentBackground: boolean;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioStream,
		transparentBackground,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioStream = audioStream;
		this.transparentBackground = (transparentBackground ?? false) && format === "webm";
		if (this.transparentBackground) {
			this.renderer.clearColor = [0, 0, 0, 0];
		}
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<Blob | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		// The MP4 index goes at the start ("fast start") so the file can play
		// while it downloads, which Discord and browsers need to stream it.
		// Reserving its space up front keeps memory flat for long exports.
		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: new Mp4OutputFormat({ fastStart: "reserve" });

		const exportTarget = await createExportTarget({
			extension: this.format === "webm" ? ".webm" : ".mp4",
		});
		const output = new Output({
			format: outputFormat,
			target: exportTarget.target,
		});

		const videoSource = new VideoSampleSource({
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
			alpha: this.transparentBackground ? "keep" : "discard",
			onEncoderConfig: applyAvcEncoderConfig,
			latencyMode: this.format === "webm" ? "realtime" : undefined,
		});

		output.addVideoTrack(videoSource, {
			frameRate: fpsFloat,
			maximumPacketCount: frameCount + PACKET_COUNT_MARGIN,
		});

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioStream) {
			// MP4 always gets AAC: Opus in MP4 does not play in Discord, on phones
			// or in most players. Browsers without a native AAC encoder (Firefox on
			// Linux) use a bundled one.
			const audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";
			if (audioCodec === "aac") {
				await ensureAacEncoder();
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource, {
				maximumPacketCount:
					Math.ceil(this.audioStream.length / MIN_AUDIO_FRAME_SAMPLES) +
					PACKET_COUNT_MARGIN,
			});
		}

		await output.start();

		// The soundtrack is mixed and encoded a window at a time, just ahead of
		// the video, so it never has to exist in memory all at once.
		const audioStream = audioSource ? this.audioStream : undefined;
		let audioSamplesAdded = 0;
		const addAudioUntil = async (seconds: number) => {
			if (!audioSource || !audioStream) return;
			const end = Math.min(
				audioStream.length,
				Math.ceil(seconds * audioStream.sampleRate),
			);
			const window = audioStream.sampleRate;
			while (audioSamplesAdded < end) {
				const windowEnd = Math.min(end, audioSamplesAdded + window);
				await audioSource.add(
					await audioStream.read({ start: audioSamplesAdded, end: windowEnd }),
				);
				audioSamplesAdded = windowEnd;
			}
		};

		const cancel = async () => {
			await output.cancel();
			await exportTarget.discard();
			this.emit("cancelled");
			return null;
		};

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				return cancel();
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			await addAudioUntil(timeSeconds + AUDIO_LOOKAHEAD_SECONDS);
			const frameSource = await this.renderer.renderFrameSource({
				node: rootNode,
				time: timeTicks,
			});
			const sample = createFrameSample({
				source: frameSource,
				timestamp: timeSeconds,
				duration: 1 / fpsFloat,
			});
			try {
				await videoSource.add(sample);
			} finally {
				sample.close();
			}

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			return cancel();
		}

		await addAudioUntil(Number.POSITIVE_INFINITY);
		audioSource?.close();
		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		const file = await exportTarget.getResult();
		if (!file) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", file);
		return file;
	}
}
