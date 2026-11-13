import type { MediaAsset } from "@/media/types";
import { StreamingPeakLimiter } from "@/media/audio-mastering";
import { mediaSupportsAudio } from "@/media/media-utils";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import { shouldMaintainPitch } from "@/retime/rate";
import type { SceneTracks } from "@/timeline";
import {
	hasAnimatedVolume,
	isElementMuted,
	resolveEffectiveAudioGain,
	type AudioCapableElement,
} from "@/timeline/audio-state";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	EXPORT_SAMPLE_RATE,
	collectAudibleCandidates,
	createAudioContext,
	fetchLibraryAudioFile,
	resolveAudioBufferForAsset,
	resolveAudioBufferForElement,
} from "./audio";
import {
	AudioSourceReader,
	ClipAudioStream,
	type StreamMixClip,
} from "./audio-stream-mix";

/** Window size used when reading the whole soundtrack in one go. */
const FULL_READ_WINDOW_SECONDS = 10;

interface ClipPlan {
	element: AudioCapableElement;
	mediaAsset: MediaAsset | null;
	outputStart: number;
	outputEnd: number;
	startTime: number;
	duration: number;
	trimStart: number;
	volume: number;
	preservesPitch: boolean;
}

/** A clip mixed from a fully decoded buffer (pitch-preserving speed, or no streaming decoder). */
interface BufferedClip {
	buffer: AudioBuffer;
	/** Source seconds to read from at clip time 0 (0 for pre-rendered buffers). */
	trimStart: number;
	/** Speed to apply while reading; undefined for pre-rendered buffers. */
	retime: AudioCapableElement["retime"];
}

type ActiveClip =
	| { plan: ClipPlan; kind: "stream"; stream: ClipAudioStream }
	| { plan: ClipPlan; kind: "buffered"; clip: BufferedClip | null };

/**
 * The project's soundtrack, mixed on demand a window at a time.
 *
 * Each clip's decoder is opened when its first sample is needed and closed
 * after its last, so memory holds a few seconds of audio regardless of the
 * project's length or how many clips it has. Exporting a long project used
 * to build the whole soundtrack (and decode whole sources) up front, which
 * could exhaust the browser's memory.
 */
export class TimelineAudioStream {
	readonly sampleRate: number;
	readonly length: number;
	readonly numberOfChannels = 2;

	private readonly plans: ClipPlan[];
	private nextPlan = 0;
	private active: ActiveClip[] = [];
	private readonly limiter: StreamingPeakLimiter;
	private readonly decodedSources = new Map<string, Promise<AudioBuffer | null>>();
	/** One reader per source file, shared by all clips cut from it. */
	private readonly readers = new Map<string, Promise<AudioSourceReader | null>>();
	private audioContext: AudioContext | null = null;

	private constructor({
		plans,
		sampleRate,
		length,
	}: {
		plans: ClipPlan[];
		sampleRate: number;
		length: number;
	}) {
		this.plans = plans;
		this.sampleRate = sampleRate;
		this.length = length;
		this.limiter = new StreamingPeakLimiter({ sampleRate });
	}

	/** Null when nothing in the project is audible. */
	static create({
		tracks,
		mediaAssets,
		duration,
		sampleRate = EXPORT_SAMPLE_RATE,
	}: {
		tracks: SceneTracks;
		mediaAssets: MediaAsset[];
		duration: number;
		sampleRate?: number;
	}): TimelineAudioStream | null {
		const plans: ClipPlan[] = [];
		for (const { element, mediaAsset } of collectAudibleCandidates({
			tracks,
			mediaAssets,
		})) {
			if (isElementMuted({ element })) continue;
			if (
				element.type === "video" &&
				(mediaAsset === null || !mediaSupportsAudio({ media: mediaAsset }))
			) {
				continue;
			}
			const startTime = element.startTime / TICKS_PER_SECOND;
			const clipDuration = element.duration / TICKS_PER_SECOND;
			const outputStart = Math.floor(startTime * sampleRate);
			plans.push({
				element,
				mediaAsset,
				outputStart,
				outputEnd: outputStart + Math.ceil(clipDuration * sampleRate),
				startTime,
				duration: clipDuration,
				trimStart: element.trimStart / TICKS_PER_SECOND,
				volume: resolveEffectiveAudioGain({
					element,
					trackMuted: false,
					localTime: 0,
				}),
				preservesPitch: shouldMaintainPitch({
					rate: element.retime?.rate ?? 1,
					maintainPitch: element.retime?.maintainPitch,
				}),
			});
		}
		if (plans.length === 0) return null;

		plans.sort((a, b) => a.outputStart - b.outputStart);
		return new TimelineAudioStream({
			plans,
			sampleRate,
			length: Math.ceil((duration / TICKS_PER_SECOND) * sampleRate),
		});
	}

	/** Mixed audio for output samples `[start, end)`; call in increasing order. */
	async read({ start, end }: { start: number; end: number }): Promise<AudioBuffer> {
		const length = Math.max(0, Math.min(end, this.length) - start);
		const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
			new Float32Array(length),
			new Float32Array(length),
		];
		const windowEnd = start + length;

		while (
			this.nextPlan < this.plans.length &&
			this.plans[this.nextPlan].outputStart < windowEnd
		) {
			const plan = this.plans[this.nextPlan++];
			if (plan.outputEnd > start) {
				this.active.push(await this.openClip({ plan }));
			}
		}

		for (const active of this.active) {
			if (active.kind === "stream") {
				await active.stream.mixInto({ channels, windowStart: start });
			} else if (active.clip) {
				mixBufferedClip({
					plan: active.plan,
					clip: active.clip,
					channels,
					windowStart: start,
					outputRate: this.sampleRate,
				});
			}
		}

		const finished = this.active.filter((active) => active.plan.outputEnd <= windowEnd);
		this.active = this.active.filter((active) => active.plan.outputEnd > windowEnd);
		await Promise.all(
			finished.map((active) =>
				active.kind === "stream" ? active.stream.close() : undefined,
			),
		);

		this.limiter.process({ channels });
		const buffer = new AudioBuffer({
			length: Math.max(1, length),
			numberOfChannels: this.numberOfChannels,
			sampleRate: this.sampleRate,
		});
		if (length > 0) {
			buffer.copyToChannel(channels[0], 0);
			buffer.copyToChannel(channels[1], 1);
		}
		return buffer;
	}

	async close(): Promise<void> {
		await Promise.all(
			this.active.map((active) =>
				active.kind === "stream" ? active.stream.close() : undefined,
			),
		);
		this.active = [];
		this.decodedSources.clear();
		for (const reader of this.readers.values()) {
			(await reader.catch(() => null))?.dispose();
		}
		this.readers.clear();
		await this.audioContext?.close().catch(() => {});
		this.audioContext = null;
	}

	private async openClip({ plan }: { plan: ClipPlan }): Promise<ActiveClip> {
		if (!plan.preservesPitch) {
			try {
				const source = await this.getReader({ plan });
				if (source) {
					const clip: StreamMixClip = {
						timelineElement: plan.element,
						startTime: plan.startTime,
						duration: plan.duration,
						trimStart: plan.trimStart,
						volume: plan.volume,
						retime: plan.element.retime,
					};
					const stream = new ClipAudioStream({
						clip,
						outputRate: this.sampleRate,
						source,
					});
					return { plan, kind: "stream", stream };
				}
			} catch (error) {
				console.warn("Streaming clip audio failed, decoding in full:", error);
			}
		}
		return { plan, kind: "buffered", clip: await this.decodeClip({ plan }) };
	}

	private getReader({ plan }: { plan: ClipPlan }): Promise<AudioSourceReader | null> {
		const key = sourceKeyOf({ plan });
		let reader = this.readers.get(key);
		if (!reader) {
			reader = this.getClipFile({ plan }).then((file) =>
				file ? AudioSourceReader.open({ file }) : null,
			);
			this.readers.set(key, reader);
		}
		return reader;
	}

	private async getClipFile({ plan }: { plan: ClipPlan }): Promise<Blob | null> {
		const { element, mediaAsset } = plan;
		if (element.type === "audio" && element.sourceType === "library") {
			return fetchLibraryAudioFile({ element });
		}
		return mediaAsset?.file ?? null;
	}

	/** Fallback: decode the whole source once (shared by clips from it). */
	private async decodeClip({ plan }: { plan: ClipPlan }): Promise<BufferedClip | null> {
		const { element, mediaAsset } = plan;
		this.audioContext ??= createAudioContext({ sampleRate: this.sampleRate });
		const audioContext = this.audioContext;
		const sourceKey = sourceKeyOf({ plan });
		let decoded = this.decodedSources.get(sourceKey);
		if (!decoded) {
			decoded =
				element.type === "audio"
					? resolveAudioBufferForElement({
							element,
							mediaMap: new Map(mediaAsset ? [[mediaAsset.id, mediaAsset]] : []),
							audioContext,
						})
					: mediaAsset
						? resolveAudioBufferForAsset({ asset: mediaAsset, audioContext })
						: Promise.resolve(null);
			this.decodedSources.set(sourceKey, decoded);
		}
		const buffer = await decoded;
		if (!buffer) return null;

		if (plan.preservesPitch) {
			const rendered = await renderRetimedBuffer({
				audioContext,
				sourceBuffer: buffer,
				trimStart: plan.trimStart,
				clipDuration: plan.duration,
				retime: element.retime,
				maintainPitch: true,
			});
			return { buffer: rendered, trimStart: 0, retime: undefined };
		}
		return { buffer, trimStart: plan.trimStart, retime: element.retime };
	}
}

function sourceKeyOf({ plan }: { plan: ClipPlan }): string {
	const { element, mediaAsset } = plan;
	return element.type === "audio" && element.sourceType === "library"
		? `library:${element.sourceUrl}`
		: `media:${mediaAsset?.id ?? element.id}`;
}

function mixBufferedClip({
	plan,
	clip,
	channels,
	windowStart,
	outputRate,
}: {
	plan: ClipPlan;
	clip: BufferedClip;
	channels: [Float32Array, Float32Array];
	windowStart: number;
	outputRate: number;
}): void {
	const windowEnd = windowStart + channels[0].length;
	const from = Math.max(plan.outputStart, windowStart);
	const to = Math.min(plan.outputEnd, windowEnd);
	const { buffer } = clip;
	const animatedVolume = hasAnimatedVolume({ element: plan.element });
	const sources = [0, 1].map((channel) =>
		buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1)),
	);

	for (let outputIndex = from; outputIndex < to; outputIndex++) {
		const clipTime = (outputIndex - plan.outputStart) / outputRate;
		const sourceIndex =
			(clip.trimStart + getSourceTimeAtClipTime({ clipTime, retime: clip.retime })) *
			buffer.sampleRate;
		const lower = Math.floor(sourceIndex);
		if (lower >= sources[0].length) break;
		const upper = Math.min(sources[0].length - 1, lower + 1);
		const fraction = sourceIndex - lower;
		const gain = animatedVolume
			? resolveEffectiveAudioGain({ element: plan.element, localTime: clipTime })
			: plan.volume;
		for (let channel = 0; channel < 2; channel++) {
			const source = sources[channel];
			channels[channel][outputIndex - windowStart] +=
				(source[lower] * (1 - fraction) + source[upper] * fraction) * gain;
		}
	}
}

/**
 * The whole soundtrack as one buffer. Prefer `TimelineAudioStream` where the
 * consumer can take it in pieces; this holds the full length in memory.
 */
export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	onProgress,
	shouldCancel,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	onProgress?: (args: { progress: number }) => void;
	shouldCancel?: () => boolean;
}): Promise<AudioBuffer | null> {
	const stream = TimelineAudioStream.create({
		tracks,
		mediaAssets,
		duration,
		sampleRate,
	});
	if (!stream) return null;

	try {
		const output = new AudioBuffer({
			length: Math.max(1, stream.length),
			numberOfChannels: stream.numberOfChannels,
			sampleRate,
		});
		const window = Math.round(FULL_READ_WINDOW_SECONDS * sampleRate);
		for (let start = 0; start < stream.length; start += window) {
			if (shouldCancel?.()) return null;
			onProgress?.({ progress: start / stream.length });
			const chunk = await stream.read({ start, end: start + window });
			for (let channel = 0; channel < stream.numberOfChannels; channel++) {
				output.copyToChannel(chunk.getChannelData(channel), channel, start);
			}
			// Let the UI repaint between windows.
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		return output;
	} finally {
		await stream.close();
	}
}
