import {
	ALL_FORMATS,
	BlobSource,
	EncodedPacketSink,
	Input,
	VideoSampleSink,
	type VideoSample,
} from "mediabunny";
import { withDecodeFallback } from "@/media/video-decoding";

/** Decoders unused for this long are closed to free their frames. */
const IDLE_SINK_TTL_MS = 15_000;
/** Frames handed out stay valid until this many later frames are produced. */
const OUTPUT_POOL_SIZE = 3;
/** Timestamps closer than this are treated as equal. */
const TIMESTAMP_EPSILON = 1e-6;

export interface DecodedVideoFrame {
	/**
	 * The frame's pixels: the decoder's own `VideoFrame` when it can be used
	 * as is (full-size decoding, i.e. export), otherwise a canvas it was
	 * scaled into. Either is recycled a few frames later; `timestamp` tells
	 * contents apart.
	 */
	source: OffscreenCanvas | VideoFrame;
	width: number;
	height: number;
	/** The video has an alpha channel (e.g. a transparent GIF converted to WebM). */
	hasAlpha: boolean;
	timestamp: number;
	duration: number;
}

/** Independent decode positions per video, e.g. both sides of a transition. */
const MAX_STREAMS_PER_SINK = 3;
/** A stream this far behind a request is still worth decoding forward. */
const MAX_FORWARD_GAP_SECONDS = 10;
/**
 * Requests this close together come from the same clip moving forward, so a
 * newer one may replace an older one. Requests further apart are different
 * clips (e.g. both sides of a transition) and must not cancel each other.
 */
const SAME_CONSUMER_SECONDS = 0.25;

/** One decoder position in a video, with its own output slots. */
interface VideoStream {
	iterator: AsyncGenerator<VideoSample, void, unknown> | null;
	/** Decoded but not yet consumed; at most one is held. */
	pending: VideoSample | null;
	/** Timestamp of the last sample pulled from the iterator. */
	position: number;
	current: DecodedVideoFrame | null;
	/** Output slots, reused in turn; each holds a canvas or a kept frame. */
	slots: OutputSlot[];
	nextSlotIndex: number;
	width: number;
	height: number;
	/** Decoded frames are handed out directly instead of drawn to a canvas. */
	keepsFrames: boolean;
	lastUsedAt: number;
	/** Requests to one stream run in order. */
	chain: Promise<unknown>;
	generation: number;
	/** Time of the newest queued request, or null when idle. */
	latestRequest: number | null;
	inFlight: number;
}

interface OutputSlot {
	canvas: OffscreenCanvas | null;
	frame: VideoFrame | null;
}

interface VideoSinkData {
	mediaId: string;
	maxSize: number | null;
	lastUsedAt: number;
	input: Input;
	samples: VideoSampleSink;
	packets: EncodedPacketSink;
	outputWidth: number;
	outputHeight: number;
	streams: VideoStream[];
}

/**
 * Decodes video frames for the renderer.
 *
 * Decoding is sequential: reaching a frame means decoding everything since
 * the previous key frame. Long recordings can have key frames minutes apart,
 * so each stream keeps decoding forward whenever that is cheaper than
 * starting over, and only draws the frames that are actually shown.
 *
 * A video can be needed at two places at once (two clips cut from it, shown
 * together during a transition). Each place gets its own stream, so they do
 * not keep throwing away each other's decoding work.
 */
export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private sweepTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * `maxSize` caps the longer side of decoded frames. The preview passes its
	 * on-screen size so it never decodes and uploads more pixels than it can
	 * show; export omits it and gets full-resolution frames from its own sink.
	 */
	async getFrameAt({
		mediaId,
		file,
		time,
		maxSize,
	}: {
		mediaId: string;
		file: File;
		time: number;
		maxSize?: number;
	}): Promise<DecodedVideoFrame | null> {
		const sinkKey = buildSinkKey({ mediaId, maxSize });
		await this.ensureSink({ sinkKey, mediaId, file, maxSize: maxSize ?? null });

		const sinkData = this.sinks.get(sinkKey);
		if (!sinkData) return null;
		const now = performance.now();
		sinkData.lastUsedAt = now;
		this.scheduleIdleSweep();

		const stream = this.pickStream({ sinkData, time });
		stream.lastUsedAt = now;
		const generation = ++stream.generation;
		stream.latestRequest = time;
		stream.inFlight++;

		const result = stream.chain
			.then(() => {
				// The same clip already asked for a later frame; skip this one.
				const isSuperseded =
					stream.generation !== generation &&
					stream.latestRequest !== null &&
					Math.abs(stream.latestRequest - time) < SAME_CONSUMER_SECONDS;
				if (isSuperseded) {
					return stream.current;
				}
				return this.resolveFrame({ sinkData, stream, time });
			})
			.finally(() => {
				stream.inFlight--;
				if (stream.inFlight === 0) {
					stream.latestRequest = null;
				}
			});
		stream.chain = result.catch(() => {});
		return result;
	}

	/** The stream that can reach `time` most cheaply. */
	private pickStream({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): VideoStream {
		// A stream busy with a request for another part of the video belongs to
		// another clip right now.
		const available = sinkData.streams.filter(
			(stream) =>
				stream.latestRequest === null ||
				Math.abs(stream.latestRequest - time) < SAME_CONSUMER_SECONDS,
		);

		const covering = available.find(
			(stream) => stream.current && isFrameAt({ frame: stream.current, time }),
		);
		if (covering) {
			return covering;
		}

		let closestBehind: VideoStream | null = null;
		for (const stream of available) {
			const position = stream.current?.timestamp ?? stream.position;
			if (
				position <= time + TIMESTAMP_EPSILON &&
				time - position <= MAX_FORWARD_GAP_SECONDS &&
				(!closestBehind ||
					position > (closestBehind.current?.timestamp ?? closestBehind.position))
			) {
				closestBehind = stream;
			}
		}
		if (closestBehind) {
			return closestBehind;
		}

		if (sinkData.streams.length < MAX_STREAMS_PER_SINK) {
			const stream = createStream({
				width: sinkData.outputWidth,
				height: sinkData.outputHeight,
				// Full-size frames need no scaling, so the decoder's frame is
				// the output: no copy into a canvas, and an encoder can take it
				// without converting it to RGB and back.
				keepsFrames: sinkData.maxSize === null,
			});
			sinkData.streams.push(stream);
			return stream;
		}

		return sinkData.streams.reduce((oldest, stream) =>
			stream.lastUsedAt < oldest.lastUsedAt ? stream : oldest,
		);
	}

	private async resolveFrame({
		sinkData,
		stream,
		time,
	}: {
		sinkData: VideoSinkData;
		stream: VideoStream;
		time: number;
	}): Promise<DecodedVideoFrame | null> {
		const current = stream.current;
		if (current && isFrameAt({ frame: current, time })) {
			return current;
		}

		try {
			return await withDecodeFallback({
				run: async () => {
					if (await this.canContinueTo({ sinkData, stream, time })) {
						const frame = await this.decodeForwardTo({ stream, time });
						if (frame) {
							return frame;
						}
					}

					await this.restartAt({ sinkData, stream, time });
					return (await this.decodeForwardTo({ stream, time })) ?? stream.current;
				},
				// The failed decoder is discarded; the retry starts a new one.
				beforeRetry: () => resetStream({ stream }),
			});
		} catch (error) {
			console.warn("Failed to decode video frame:", error);
			await resetStream({ stream });
			return stream.current;
		}
	}

	/**
	 * Continuing is right when the target lies ahead and no key frame sits
	 * between the decode position and the target; otherwise restarting at
	 * that later key frame skips work.
	 */
	private async canContinueTo({
		sinkData,
		stream,
		time,
	}: {
		sinkData: VideoSinkData;
		stream: VideoStream;
		time: number;
	}): Promise<boolean> {
		if (!stream.iterator) {
			return false;
		}
		const position = stream.pending?.timestamp ?? stream.position;
		if (time + TIMESTAMP_EPSILON < position) {
			return false;
		}
		const keyPacket = await sinkData.packets.getKeyPacket(time, {
			metadataOnly: true,
		});
		const keyTimestamp = keyPacket?.timestamp ?? 0;
		return keyTimestamp <= position + TIMESTAMP_EPSILON;
	}

	private async restartAt({
		sinkData,
		stream,
		time,
	}: {
		sinkData: VideoSinkData;
		stream: VideoStream;
		time: number;
	}): Promise<void> {
		await resetStream({ stream });
		stream.iterator = sinkData.samples.samples(time);
		stream.position = Number.NEGATIVE_INFINITY;
	}

	/**
	 * Pulls decoded samples until one covers `time`, closing the ones before
	 * it without drawing them. Returns null when the stream ends first.
	 */
	private async decodeForwardTo({
		stream,
		time,
	}: {
		stream: VideoStream;
		time: number;
	}): Promise<DecodedVideoFrame | null> {
		const iterator = stream.iterator;
		if (!iterator) {
			return null;
		}

		while (true) {
			let sample = stream.pending;
			stream.pending = null;
			if (!sample) {
				const result = await iterator.next();
				if (result.done) {
					return null;
				}
				sample = result.value;
				stream.position = sample.timestamp;
			}

			const sampleEnd = sample.timestamp + sample.duration;
			const coversTime =
				time + TIMESTAMP_EPSILON >= sample.timestamp && time < sampleEnd;
			// A sample past the target means there is a gap; show the next frame.
			const isPastTime = sample.timestamp > time + TIMESTAMP_EPSILON;
			if (coversTime || isPastTime) {
				const frame = drawSample({ stream, sample });
				if (isPastTime) {
					stream.pending = sample;
				} else {
					sample.close();
				}
				return frame;
			}

			sample.close();
		}
	}

	private async ensureSink({
		sinkKey,
		mediaId,
		file,
		maxSize,
	}: {
		sinkKey: string;
		mediaId: string;
		file: File;
		maxSize: number | null;
	}): Promise<void> {
		if (this.sinks.has(sinkKey)) return;

		if (this.initPromises.has(sinkKey)) {
			await this.initPromises.get(sinkKey);
			return;
		}

		// Only one size-limited sink per video: a new preview size replaces the
		// old one instead of keeping another decoder alive.
		if (maxSize !== null) {
			for (const [key, sinkData] of this.sinks) {
				if (sinkData.mediaId === mediaId && sinkData.maxSize !== null) {
					this.disposeSink({ sinkKey: key });
				}
			}
		}

		const initPromise = this.initializeSink({ sinkKey, mediaId, file, maxSize });
		this.initPromises.set(sinkKey, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(sinkKey);
		}
	}

	private async initializeSink({
		sinkKey,
		mediaId,
		file,
		maxSize,
	}: {
		sinkKey: string;
		mediaId: string;
		file: File;
		maxSize: number | null;
	}): Promise<void> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});

		try {
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const { width, height } = getOutputSize({
				width: videoTrack.displayWidth,
				height: videoTrack.displayHeight,
				maxSize,
			});

			this.sinks.set(sinkKey, {
				mediaId,
				maxSize,
				lastUsedAt: performance.now(),
				input,
				samples: new VideoSampleSink(videoTrack),
				packets: new EncodedPacketSink(videoTrack),
				outputWidth: width,
				outputHeight: height,
				streams: [],
			});
		} catch (error) {
			input.dispose();
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		}
	}

	/**
	 * Every open decoder holds frame canvases (about 100 MB for 4K) and
	 * decoder buffers. Closing the ones nobody has asked for recently keeps a
	 * long session with many clips from growing without bound.
	 */
	private scheduleIdleSweep(): void {
		if (this.sweepTimer !== null || typeof window === "undefined") {
			return;
		}
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = null;
			const now = performance.now();
			for (const [sinkKey, sinkData] of [...this.sinks]) {
				if (now - sinkData.lastUsedAt >= IDLE_SINK_TTL_MS) {
					this.disposeSink({ sinkKey });
					continue;
				}
				// Within a live video, drop streams no longer being played.
				sinkData.streams = sinkData.streams.filter((stream) => {
					const isIdle = now - stream.lastUsedAt >= IDLE_SINK_TTL_MS;
					if (isIdle) void releaseStream({ stream });
					return !isIdle;
				});
			}
			if (this.sinks.size > 0) {
				this.scheduleIdleSweep();
			}
		}, IDLE_SINK_TTL_MS);
	}

	private disposeSink({ sinkKey }: { sinkKey: string }): void {
		const sinkData = this.sinks.get(sinkKey);
		if (sinkData) {
			for (const stream of sinkData.streams) {
				void releaseStream({ stream });
			}
			sinkData.streams = [];
			sinkData.input.dispose();
			this.sinks.delete(sinkKey);
		}
		this.initPromises.delete(sinkKey);
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		for (const [sinkKey, sinkData] of [...this.sinks]) {
			if (sinkData.mediaId === mediaId) {
				this.disposeSink({ sinkKey });
			}
		}
		for (const sinkKey of [...this.initPromises.keys()]) {
			if (sinkKey.startsWith(`${mediaId}|`)) {
				this.initPromises.delete(sinkKey);
			}
		}
	}

	clearAll(): void {
		for (const sinkKey of [...this.sinks.keys()]) {
			this.disposeSink({ sinkKey });
		}
	}

	getStats() {
		const streams = Array.from(this.sinks.values()).flatMap((s) => s.streams);
		return {
			totalSinks: this.sinks.size,
			activeSinks: streams.filter((stream) => stream.iterator).length,
			cachedFrames: streams.filter((stream) => stream.current).length,
		};
	}
}

function createStream({
	width,
	height,
	keepsFrames,
}: {
	width: number;
	height: number;
	keepsFrames: boolean;
}): VideoStream {
	return {
		iterator: null,
		pending: null,
		position: Number.NEGATIVE_INFINITY,
		current: null,
		slots: Array.from({ length: OUTPUT_POOL_SIZE }, () => ({
			canvas: null,
			frame: null,
		})),
		nextSlotIndex: 0,
		width,
		height,
		keepsFrames,
		lastUsedAt: performance.now(),
		chain: Promise.resolve(),
		generation: 0,
		latestRequest: null,
		inFlight: 0,
	};
}

async function resetStream({ stream }: { stream: VideoStream }): Promise<void> {
	stream.pending?.close();
	stream.pending = null;
	const iterator = stream.iterator;
	stream.iterator = null;
	stream.position = Number.NEGATIVE_INFINITY;
	await iterator?.return();
}

/** Resets the stream and frees the frames it still holds. */
async function releaseStream({ stream }: { stream: VideoStream }): Promise<void> {
	await resetStream({ stream });
	stream.current = null;
	for (const slot of stream.slots) {
		slot.frame?.close();
		slot.frame = null;
		slot.canvas = null;
	}
}

function drawSample({
	stream,
	sample,
}: {
	stream: VideoStream;
	sample: VideoSample;
}): DecodedVideoFrame {
	const slot = stream.slots[stream.nextSlotIndex];
	stream.nextSlotIndex = (stream.nextSlotIndex + 1) % stream.slots.length;
	slot.frame?.close();
	slot.frame = null;

	let source: OffscreenCanvas | VideoFrame;
	if (
		stream.keepsFrames &&
		sample.rotation === 0 &&
		sample.displayWidth === stream.width &&
		sample.displayHeight === stream.height
	) {
		// A new reference to the same pixels; nothing is copied.
		slot.frame = sample.toVideoFrame();
		source = slot.frame;
	} else {
		slot.canvas ??= new OffscreenCanvas(stream.width, stream.height);
		const ctx = slot.canvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get 2d context for video frame");
		}
		ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
		sample.drawWithFit(ctx, { fit: "contain" });
		source = slot.canvas;
	}

	const frame: DecodedVideoFrame = {
		source,
		width: stream.width,
		height: stream.height,
		hasAlpha: sample.hasAlpha === true,
		timestamp: sample.timestamp,
		duration: sample.duration,
	};
	stream.current = frame;
	return frame;
}

function isFrameAt({
	frame,
	time,
}: {
	frame: DecodedVideoFrame;
	time: number;
}): boolean {
	return (
		time + TIMESTAMP_EPSILON >= frame.timestamp &&
		time < frame.timestamp + frame.duration
	);
}

function buildSinkKey({
	mediaId,
	maxSize,
}: {
	mediaId: string;
	maxSize?: number;
}): string {
	return `${mediaId}|${maxSize ?? "full"}`;
}

function getOutputSize({
	width,
	height,
	maxSize,
}: {
	width: number;
	height: number;
	maxSize: number | null;
}): { width: number; height: number } {
	const longEdge = Math.max(width, height);
	if (maxSize === null || longEdge <= maxSize) {
		return { width, height };
	}
	const scale = maxSize / longEdge;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

export const videoCache = new VideoCache();
