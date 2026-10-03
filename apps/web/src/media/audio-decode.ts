import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import type { SourceWaveformSummary } from "./waveform-summary";

/** Extra room for container durations that round down. */
const DURATION_SLACK_SECONDS = 0.5;

/**
 * Decodes a file's primary audio track into one AudioBuffer at
 * `targetSampleRate`.
 *
 * Chunks are copied into a preallocated buffer as they are decoded, so peak
 * memory is roughly one copy of the decoded audio, and the slow resampling
 * pass only runs when the source rate differs from the target.
 */
export async function decodeFileAudio({
	file,
	audioContext,
	maxChannels = 2,
}: {
	file: Blob;
	audioContext: BaseAudioContext;
	maxChannels?: number;
}): Promise<AudioBuffer | null> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			return null;
		}

		const nativeSampleRate = audioTrack.sampleRate;
		const numChannels = Math.max(
			1,
			Math.min(maxChannels, audioTrack.numberOfChannels),
		);
		const durationSeconds = await audioTrack.computeDuration();
		const capacity = Math.ceil(
			(durationSeconds + DURATION_SLACK_SECONDS) * nativeSampleRate,
		);
		if (capacity <= 0) {
			return null;
		}

		const native = audioContext.createBuffer(
			numChannels,
			capacity,
			nativeSampleRate,
		);
		let written = 0;
		const sink = new AudioBufferSink(audioTrack);
		for await (const { buffer } of sink.buffers(0)) {
			const length = Math.min(buffer.length, capacity - written);
			if (length <= 0) {
				break;
			}
			for (let channel = 0; channel < numChannels; channel++) {
				const data = buffer.getChannelData(
					Math.min(channel, buffer.numberOfChannels - 1),
				);
				native.copyToChannel(
					length === buffer.length ? data : data.subarray(0, length),
					channel,
					written,
				);
			}
			written += length;
		}
		if (written === 0) {
			return null;
		}

		const targetSampleRate = audioContext.sampleRate;
		if (nativeSampleRate === targetSampleRate) {
			return native;
		}

		const offlineContext = new OfflineAudioContext(
			numChannels,
			Math.ceil(written * (targetSampleRate / nativeSampleRate)),
			targetSampleRate,
		);
		const sourceNode = offlineContext.createBufferSource();
		sourceNode.buffer = native;
		sourceNode.connect(offlineContext.destination);
		sourceNode.start(0);
		return await offlineContext.startRendering();
	} finally {
		input.dispose();
	}
}

/**
 * Builds a waveform summary (the loudest sample of every `bucketSize`
 * samples) while decoding, without ever holding the whole track in memory.
 */
export async function streamWaveformSummary({
	sourceKey,
	file,
	bucketSize,
}: {
	sourceKey: string;
	file: Blob;
	bucketSize: number;
}): Promise<SourceWaveformSummary | null> {
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) {
			return null;
		}

		const sampleRate = audioTrack.sampleRate;
		const durationSeconds = await audioTrack.computeDuration();
		let amplitudes = new Float32Array(
			Math.max(
				1,
				Math.ceil(((durationSeconds + DURATION_SLACK_SECONDS) * sampleRate) / bucketSize),
			),
		);
		let totalSamples = 0;
		let bucketIndex = 0;
		let bucketFill = 0;
		let bucketPeak = 0;

		const sink = new AudioBufferSink(audioTrack);
		for await (const { buffer } of sink.buffers(0)) {
			const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
				buffer.getChannelData(c),
			);
			for (let index = 0; index < buffer.length; index++) {
				for (const data of channels) {
					const value = Math.abs(data[index]);
					if (value > bucketPeak) {
						bucketPeak = value;
					}
				}
				bucketFill++;
				if (bucketFill === bucketSize) {
					if (bucketIndex >= amplitudes.length) {
						const grown = new Float32Array(amplitudes.length * 2);
						grown.set(amplitudes);
						amplitudes = grown;
					}
					amplitudes[bucketIndex++] = bucketPeak;
					bucketFill = 0;
					bucketPeak = 0;
				}
			}
			totalSamples += buffer.length;
		}

		if (bucketFill > 0) {
			if (bucketIndex >= amplitudes.length) {
				const grown = new Float32Array(amplitudes.length + 1);
				grown.set(amplitudes);
				amplitudes = grown;
			}
			amplitudes[bucketIndex++] = bucketPeak;
		}
		if (totalSamples === 0) {
			return null;
		}

		return {
			sourceKey,
			sampleRate,
			totalSamples,
			bucketSize,
			amplitudes: amplitudes.slice(0, bucketIndex),
		};
	} finally {
		input.dispose();
	}
}
