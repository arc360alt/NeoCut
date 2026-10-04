import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
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
	file: Blob;
	/** Seconds on the timeline. */
	startTime: number;
	duration: number;
	/** Seconds into the source. */
	trimStart: number;
	volume: number;
	retime?: RetimeConfig;
}

/**
 * Mixes one clip into `outputBuffer`, decoding only the part of the source
 * it plays, chunk by chunk. Memory stays at one decoded chunk no matter how
 * long the source is or how many clips share it.
 *
 * Returns false when the file has no decodable audio track and nothing was
 * mixed, so the caller can fall back to another decoder.
 */
export async function streamMixClip({
	clip,
	outputBuffer,
}: {
	clip: StreamMixClip;
	outputBuffer: AudioBuffer;
}): Promise<boolean> {
	const input = new Input({ source: new BlobSource(clip.file), formats: ALL_FORMATS });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack || !(await audioTrack.canDecode())) {
			return false;
		}

		const outputRate = outputBuffer.sampleRate;
		const outputLength = outputBuffer.length;
		const outputStart = Math.floor(clip.startTime * outputRate);
		const renderedLength = Math.ceil(clip.duration * outputRate);
		const outputChannels = [0, 1].map((channel) =>
			outputBuffer.getChannelData(Math.min(channel, outputBuffer.numberOfChannels - 1)),
		);
		const animatedVolume = hasAnimatedVolume({ element: clip.timelineElement });

		// Output sample i plays the source at sourceTimeAt(i); speed is constant.
		const sourceTimeAt = (index: number) =>
			clip.trimStart +
			getSourceTimeAtClipTime({ clipTime: index / outputRate, retime: clip.retime });
		const sourceEnd = sourceTimeAt(renderedLength) + SOURCE_END_MARGIN_SECONDS;
		const secondsPerIndex = sourceTimeAt(1) - sourceTimeAt(0);

		let nextIndex = 0;
		let previous: { time: number; values: [number, number] } | null = null;
		const sink = new AudioBufferSink(audioTrack);

		for await (const { buffer, timestamp } of sink.buffers(clip.trimStart, sourceEnd)) {
			if (nextIndex >= renderedLength) break;

			const sourceRate = buffer.sampleRate;
			const length = buffer.length;
			if (length === 0) continue;
			const left = buffer.getChannelData(0);
			const right = buffer.getChannelData(Math.min(1, buffer.numberOfChannels - 1));
			const lastTime = timestamp + (length - 1) / sourceRate;

			// Output samples whose source position falls before this chunk's last
			// sample can be produced now (using the previous chunk's last sample
			// to interpolate across the boundary).
			const lastIndex = Math.min(
				renderedLength - 1,
				Math.floor((lastTime - clip.trimStart) / secondsPerIndex),
			);

			for (let index = nextIndex; index <= lastIndex; index++) {
				const outputIndex = outputStart + index;
				if (outputIndex >= outputLength) {
					nextIndex = renderedLength;
					break;
				}

				const position = (sourceTimeAt(index) - timestamp) * sourceRate;
				const lower = Math.floor(position);
				const fraction = position - lower;
				let leftValue: number;
				let rightValue: number;
				if (lower < 0) {
					// Before this chunk: blend from the previous chunk's last sample.
					const before = previous?.values ?? [left[0], right[0]];
					const weight = previous ? Math.min(1, Math.max(0, position + 1)) : 1;
					leftValue = before[0] * (1 - weight) + left[0] * weight;
					rightValue = before[1] * (1 - weight) + right[0] * weight;
				} else {
					const upper = Math.min(length - 1, lower + 1);
					leftValue = left[lower] * (1 - fraction) + left[upper] * fraction;
					rightValue = right[lower] * (1 - fraction) + right[upper] * fraction;
				}

				const gain = animatedVolume
					? resolveEffectiveAudioGain({
							element: clip.timelineElement,
							localTime: index / outputRate,
						})
					: clip.volume;
				outputChannels[0][outputIndex] += leftValue * gain;
				outputChannels[1][outputIndex] += rightValue * gain;
				nextIndex = index + 1;
			}

			previous = { time: lastTime, values: [left[length - 1], right[length - 1]] };
		}

		return true;
	} finally {
		input.dispose();
	}
}
