const MASTER_LIMITER_THRESHOLD_DB = -1;
const MASTER_LIMITER_KNEE_DB = 0;
const MASTER_LIMITER_RATIO = 20;
const MASTER_LIMITER_ATTACK_SECONDS = 0.001;
const MASTER_LIMITER_RELEASE_SECONDS = 0.12;
const MASTER_OUTPUT_HEADROOM = 0.98;

export function getAudioBufferPeak({
	audioBuffer,
}: {
	audioBuffer: AudioBuffer;
}): number {
	let peak = 0;

	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			const magnitude = Math.abs(channelData[index]);
			if (magnitude > peak) {
				peak = magnitude;
			}
		}
	}

	return peak;
}

export function createAudioMasteringChain({
	audioContext,
	destination,
}: {
	audioContext: AudioContext | OfflineAudioContext;
	destination: AudioNode;
}): {
	input: GainNode;
} {
	const input = audioContext.createGain();
	const limiter = audioContext.createDynamicsCompressor();
	const outputGain = audioContext.createGain();

	limiter.threshold.value = MASTER_LIMITER_THRESHOLD_DB;
	limiter.knee.value = MASTER_LIMITER_KNEE_DB;
	limiter.ratio.value = MASTER_LIMITER_RATIO;
	limiter.attack.value = MASTER_LIMITER_ATTACK_SECONDS;
	limiter.release.value = MASTER_LIMITER_RELEASE_SECONDS;
	outputGain.gain.value = MASTER_OUTPUT_HEADROOM;

	input.connect(limiter);
	limiter.connect(outputGain);
	outputGain.connect(destination);

	return { input };
}

export async function applyAudioMasteringToBuffer({
	audioBuffer,
}: {
	audioBuffer: AudioBuffer;
}): Promise<AudioBuffer> {
	if (getAudioBufferPeak({ audioBuffer }) <= MASTER_OUTPUT_HEADROOM) {
		return audioBuffer;
	}

	const offlineContext = new OfflineAudioContext(
		audioBuffer.numberOfChannels,
		Math.max(1, audioBuffer.length),
		audioBuffer.sampleRate,
	);
	const source = offlineContext.createBufferSource();
	source.buffer = audioBuffer;

	const { input } = createAudioMasteringChain({
		audioContext: offlineContext,
		destination: offlineContext.destination,
	});
	source.connect(input);
	source.start(0);

	const renderedBuffer = await offlineContext.startRendering();
	clampAudioBufferPeak({
		audioBuffer: renderedBuffer,
		maxPeak: MASTER_OUTPUT_HEADROOM,
	});
	return renderedBuffer;
}

function clampAudioBufferPeak({
	audioBuffer,
	maxPeak,
}: {
	audioBuffer: AudioBuffer;
	maxPeak: number;
}): void {
	for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
		const channelData = audioBuffer.getChannelData(channel);
		for (let index = 0; index < channelData.length; index++) {
			channelData[index] = Math.max(
				-maxPeak,
				Math.min(maxPeak, channelData[index]),
			);
		}
	}
}

/**
 * The master limiter applied while streaming, a window at a time. Audio that
 * stays under the output headroom passes through untouched; louder peaks are
 * pulled down instantly and released smoothly, then hard-clamped.
 */
export class StreamingPeakLimiter {
	private envelope = 1;
	private readonly releaseCoefficient: number;

	constructor({ sampleRate }: { sampleRate: number }) {
		this.releaseCoefficient =
			1 - Math.exp(-1 / (MASTER_LIMITER_RELEASE_SECONDS * sampleRate));
	}

	process({ channels }: { channels: Float32Array[] }): void {
		const length = channels[0]?.length ?? 0;
		for (let index = 0; index < length; index++) {
			let peak = 0;
			for (const data of channels) {
				const magnitude = Math.abs(data[index]);
				if (magnitude > peak) peak = magnitude;
			}
			const target = peak > MASTER_OUTPUT_HEADROOM ? MASTER_OUTPUT_HEADROOM / peak : 1;
			if (target < this.envelope) {
				this.envelope = target;
			} else {
				this.envelope += (target - this.envelope) * this.releaseCoefficient;
				if (this.envelope > 0.99999) this.envelope = 1;
			}
			if (this.envelope === 1 && peak <= MASTER_OUTPUT_HEADROOM) continue;
			for (const data of channels) {
				data[index] = Math.max(
					-MASTER_OUTPUT_HEADROOM,
					Math.min(MASTER_OUTPUT_HEADROOM, data[index] * this.envelope),
				);
			}
		}
	}
}
