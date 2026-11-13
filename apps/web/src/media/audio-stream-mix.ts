import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	Input,
	type WrappedAudioBuffer,
} from "mediabunny";
import { getSourceTimeAtClipTime } from "@/retime";
import type { RetimeConfig } from "@/timeline";
import {
	hasAnimatedVolume,
	resolveEffectiveAudioGain,
	type AudioCapableElement,
} from "@/timeline/audio-state";

/** Decoded past the clip's end so interpolation has a following sample. */
const SOURCE_END_MARGIN_SECONDS = 0.05;

export interface StreamMixClip {
	timelineElement: AudioCapableElement;
	/** Seconds on the timeline. */
	startTime: number;
	duration: number;
	/** Seconds into the source. */
	trimStart: number;
	volume: number;
	retime?: RetimeConfig;
}

interface DecodedChunk {
	left: Float32Array;
	right: Float32Array;
	timestamp: number;
	sampleRate: number;
	length: number;
	lastTime: number;
}

/**
 * One opened source file, shared by every clip cut from it. Opening an
 * `Input` parses the file's index (large for long recordings), so a long edit
 * with hundreds of clips from one file must not open it once per clip.
 */
export class AudioSourceReader {
	private readonly input: Input;
	readonly sink: AudioBufferSink;

	private constructor({ input, sink }: { input: Input; sink: AudioBufferSink }) {
		this.input = input;
		this.sink = sink;
	}

	/** Null when the file has no audio track this browser can decode. */
	static async open({ file }: { file: Blob }): Promise<AudioSourceReader | null> {
		const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
		try {
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack || !(await audioTrack.canDecode())) {
				input.dispose();
				return null;
			}
			return new AudioSourceReader({ input, sink: new AudioBufferSink(audioTrack) });
		} catch (error) {
			input.dispose();
			throw error;
		}
	}

	dispose(): void {
		this.input.dispose();
	}
}

/**
 * One clip's audio, decoded incrementally from its source and mixed into the
 * output a window at a time. Only the part of the source the clip plays is
 * decoded, and only one chunk is held at once, so memory does not depend on
 * how long the source is.
 */
export class ClipAudioStream {
	/** First output sample (absolute, at the output rate) this clip covers. */
	readonly outputStart: number;
	/** Number of output samples the clip covers. */
	readonly renderedLength: number;

	private chunk: DecodedChunk | null = null;
	private previous: [number, number] | null = null;
	/** Next output sample to produce, relative to `outputStart`. */
	private nextIndex = 0;
	private finished = false;
	private readonly animatedVolume: boolean;
	private readonly secondsPerIndex: number;

	private readonly clip: StreamMixClip;
	private readonly outputRate: number;
	private readonly iterator: AsyncGenerator<WrappedAudioBuffer, void, unknown>;

	constructor({
		clip,
		outputRate,
		source,
	}: {
		clip: StreamMixClip;
		outputRate: number;
		source: AudioSourceReader;
	}) {
		this.clip = clip;
		this.outputRate = outputRate;
		const renderedLength = Math.ceil(clip.duration * outputRate);
		const sourceEnd =
			clip.trimStart +
			getSourceTimeAtClipTime({
				clipTime: renderedLength / outputRate,
				retime: clip.retime,
			}) +
			SOURCE_END_MARGIN_SECONDS;
		this.iterator = source.sink.buffers(clip.trimStart, sourceEnd);
		this.outputStart = Math.floor(clip.startTime * outputRate);
		this.renderedLength = Math.ceil(clip.duration * outputRate);
		this.animatedVolume = hasAnimatedVolume({ element: clip.timelineElement });
		// Retiming is a constant rate, so source time is linear in the index.
		this.secondsPerIndex = getSourceTimeAtClipTime({
			clipTime: 1 / outputRate,
			retime: clip.retime,
		});
	}

	get outputEnd(): number {
		return this.outputStart + this.renderedLength;
	}

	/**
	 * Adds this clip's samples for `[windowStart, windowStart + length)` into
	 * `channels`. Windows must be requested in order.
	 */
	async mixInto({
		channels,
		windowStart,
	}: {
		channels: [Float32Array, Float32Array];
		windowStart: number;
	}): Promise<void> {
		const windowEnd = windowStart + channels[0].length;
		const endIndex = Math.min(this.renderedLength, windowEnd - this.outputStart);
		this.nextIndex = Math.max(this.nextIndex, windowStart - this.outputStart);

		while (this.nextIndex < endIndex && !this.finished) {
			const chunk = this.chunk;
			if (!chunk || this.sourceTimeAt(this.nextIndex) > chunk.lastTime) {
				await this.pullChunk();
				continue;
			}

			const lastIndex = Math.min(
				endIndex - 1,
				Math.floor((chunk.lastTime - this.clip.trimStart) / this.secondsPerIndex),
			);
			if (lastIndex < this.nextIndex) {
				await this.pullChunk();
				continue;
			}

			this.mixRange({
				chunk,
				channels,
				from: this.nextIndex,
				to: lastIndex,
				windowStart,
			});
			this.nextIndex = lastIndex + 1;
		}
	}

	async close(): Promise<void> {
		this.finished = true;
		this.chunk = null;
		await this.iterator.return().catch(() => {});
	}

	private sourceTimeAt(index: number): number {
		return this.clip.trimStart + index * this.secondsPerIndex;
	}

	/**
	 * Adds output samples `from..to` (inclusive), all inside `chunk`. This is
	 * the hot loop of exporting audio, so it avoids per-sample calls and
	 * allocations.
	 */
	private mixRange({
		chunk,
		channels,
		from,
		to,
		windowStart,
	}: {
		chunk: DecodedChunk;
		channels: [Float32Array, Float32Array];
		from: number;
		to: number;
		windowStart: number;
	}): void {
		const [outLeft, outRight] = channels;
		const { left, right, length } = chunk;
		const last = length - 1;
		const step = this.secondsPerIndex * chunk.sampleRate;
		const origin = (this.clip.trimStart - chunk.timestamp) * chunk.sampleRate;
		const offset = this.outputStart - windowStart;
		const constantGain = this.animatedVolume ? 0 : this.clip.volume;

		for (let index = from; index <= to; index++) {
			const position = origin + index * step;
			let sampleLeft: number;
			let sampleRight: number;
			if (position < 0) {
				[sampleLeft, sampleRight] = this.sampleAt({ chunk, index });
			} else {
				const lower = Math.min(Math.floor(position), last);
				const fraction = position - lower;
				const upper = lower < last ? lower + 1 : last;
				sampleLeft = left[lower] + (left[upper] - left[lower]) * fraction;
				sampleRight = right[lower] + (right[upper] - right[lower]) * fraction;
			}
			const gain = this.animatedVolume
				? resolveEffectiveAudioGain({
						element: this.clip.timelineElement,
						localTime: index / this.outputRate,
					})
				: constantGain;
			outLeft[offset + index] += sampleLeft * gain;
			outRight[offset + index] += sampleRight * gain;
		}
	}

	private async pullChunk(): Promise<void> {
		const result = await this.iterator.next();
		if (result.done) {
			this.finished = true;
			return;
		}
		const { buffer, timestamp } = result.value;
		if (this.chunk) {
			const last = this.chunk.length - 1;
			this.previous = [this.chunk.left[last], this.chunk.right[last]];
		}
		this.chunk = {
			left: buffer.getChannelData(0),
			right: buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1)),
			timestamp,
			sampleRate: buffer.sampleRate,
			length: buffer.length,
			lastTime: timestamp + (buffer.length - 1) / buffer.sampleRate,
		};
	}

	/** Linear interpolation, reaching back into the previous chunk if needed. */
	private sampleAt({
		chunk,
		index,
	}: {
		chunk: DecodedChunk;
		index: number;
	}): [number, number] {
		const position = (this.sourceTimeAt(index) - chunk.timestamp) * chunk.sampleRate;
		const lower = Math.floor(position);
		if (lower < 0) {
			const before = this.previous ?? [chunk.left[0], chunk.right[0]];
			const weight = this.previous ? Math.min(1, Math.max(0, position + 1)) : 1;
			return [
				before[0] * (1 - weight) + chunk.left[0] * weight,
				before[1] * (1 - weight) + chunk.right[0] * weight,
			];
		}
		const fraction = position - lower;
		const upper = Math.min(chunk.length - 1, lower + 1);
		return [
			chunk.left[lower] * (1 - fraction) + chunk.left[upper] * fraction,
			chunk.right[lower] * (1 - fraction) + chunk.right[upper] * fraction,
		];
	}
}
