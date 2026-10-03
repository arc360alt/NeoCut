import {
	ALL_FORMATS,
	BlobSource,
	EncodedPacketSink,
	Input,
	VideoSampleSink,
	type VideoSample,
} from "mediabunny";

/** Decoders unused for this long are closed to free their frames. */
const IDLE_SINK_TTL_MS = 15_000;
/** Frames handed out stay valid until this many later frames are drawn. */
const OUTPUT_CANVAS_POOL_SIZE = 3;
/** Timestamps closer than this are treated as equal. */
const TIMESTAMP_EPSILON = 1e-6;

export interface DecodedVideoFrame {
	/** Reused for later frames; `timestamp` tells its contents apart. */
	canvas: OffscreenCanvas;
	timestamp: number;
	duration: number;
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
	iterator: AsyncGenerator<VideoSample, void, unknown> | null;
	/** Decoded but not yet consumed; at most one is held. */
	pending: VideoSample | null;
	/** Timestamp of the last sample pulled from the iterator. */
	position: number;
	current: DecodedVideoFrame | null;
	canvases: OffscreenCanvas[];
	nextCanvasIndex: number;
}

/**
 * Decodes video frames for the renderer.
 *
 * Decoding is sequential: reaching a frame means decoding everything since
 * the previous key frame. Long recordings can have key frames minutes apart,
 * so the cache keeps decoding forward whenever that is cheaper than starting
 * over, and only draws the frames that are actually shown.
 */
export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();
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
		sinkData.lastUsedAt = performance.now();
		this.scheduleIdleSweep();

		const generation = (this.seekGenerations.get(sinkKey) ?? 0) + 1;
		this.seekGenerations.set(sinkKey, generation);

		const previous = this.frameChain.get(sinkKey) ?? Promise.resolve();
		const current = previous.then(() => {
			// A newer request superseded this one while it waited; skip the work.
			if (this.seekGenerations.get(sinkKey) !== generation) {
				return sinkData.current;
			}
			return this.resolveFrame({ sinkData, time });
		});
		this.frameChain.set(
			sinkKey,
			current.catch(() => {}),
		);
		return current;
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<DecodedVideoFrame | null> {
		const current = sinkData.current;
		if (current && isFrameAt({ frame: current, time })) {
			return current;
		}

		try {
			if (await this.canContinueTo({ sinkData, time })) {
				const frame = await this.decodeForwardTo({ sinkData, time });
				if (frame) {
					return frame;
				}
			}

			await this.restartAt({ sinkData, time });
			return (await this.decodeForwardTo({ sinkData, time })) ?? sinkData.current;
		} catch (error) {
			console.warn("Failed to decode video frame:", error);
			await this.resetIterator({ sinkData });
			return sinkData.current;
		}
	}

	/**
	 * Continuing is right when the target lies ahead and no key frame sits
	 * between the decode position and the target; otherwise restarting at
	 * that later key frame skips work.
	 */
	private async canContinueTo({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<boolean> {
		if (!sinkData.iterator) {
			return false;
		}
		const position = sinkData.pending?.timestamp ?? sinkData.position;
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
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<void> {
		await this.resetIterator({ sinkData });
		sinkData.iterator = sinkData.samples.samples(time);
		sinkData.position = Number.NEGATIVE_INFINITY;
	}

	private async resetIterator({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		sinkData.pending?.close();
		sinkData.pending = null;
		const iterator = sinkData.iterator;
		sinkData.iterator = null;
		sinkData.position = Number.NEGATIVE_INFINITY;
		await iterator?.return();
	}

	/**
	 * Pulls decoded samples until one covers `time`, closing the ones before
	 * it without drawing them. Returns null when the stream ends first.
	 */
	private async decodeForwardTo({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<DecodedVideoFrame | null> {
		const iterator = sinkData.iterator;
		if (!iterator) {
			return null;
		}

		while (true) {
			let sample = sinkData.pending;
			sinkData.pending = null;
			if (!sample) {
				const result = await iterator.next();
				if (result.done) {
					return null;
				}
				sample = result.value;
				sinkData.position = sample.timestamp;
			}

			const sampleEnd = sample.timestamp + sample.duration;
			const coversTime = time + TIMESTAMP_EPSILON >= sample.timestamp && time < sampleEnd;
			// A sample past the target means there is a gap; show the next frame.
			const isPastTime = sample.timestamp > time + TIMESTAMP_EPSILON;
			if (coversTime || isPastTime) {
				const frame = this.drawSample({ sinkData, sample });
				if (isPastTime) {
					sinkData.pending = sample;
				} else {
					sample.close();
				}
				return frame;
			}

			sample.close();
		}
	}

	private drawSample({
		sinkData,
		sample,
	}: {
		sinkData: VideoSinkData;
		sample: VideoSample;
	}): DecodedVideoFrame {
		const canvas = sinkData.canvases[sinkData.nextCanvasIndex];
		sinkData.nextCanvasIndex =
			(sinkData.nextCanvasIndex + 1) % sinkData.canvases.length;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("Failed to get 2d context for video frame");
		}
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		sample.drawWithFit(ctx, { fit: "contain" });

		const frame: DecodedVideoFrame = {
			canvas,
			timestamp: sample.timestamp,
			duration: sample.duration,
		};
		sinkData.current = frame;
		return frame;
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
				iterator: null,
				pending: null,
				position: Number.NEGATIVE_INFINITY,
				current: null,
				canvases: Array.from(
					{ length: OUTPUT_CANVAS_POOL_SIZE },
					() => new OffscreenCanvas(width, height),
				),
				nextCanvasIndex: 0,
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
				}
			}
			if (this.sinks.size > 0) {
				this.scheduleIdleSweep();
			}
		}, IDLE_SINK_TTL_MS);
	}

	private disposeSink({ sinkKey }: { sinkKey: string }): void {
		const sinkData = this.sinks.get(sinkKey);
		if (sinkData) {
			sinkData.pending?.close();
			sinkData.pending = null;
			if (sinkData.iterator) {
				void sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.input.dispose();
			this.sinks.delete(sinkKey);
		}

		this.initPromises.delete(sinkKey);
		this.frameChain.delete(sinkKey);
		this.seekGenerations.delete(sinkKey);
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
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter((s) => s.current)
				.length,
		};
	}
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
