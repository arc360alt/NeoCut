import { describe, expect, mock, test } from "bun:test";
import type { AudioSourceReader, StreamMixClip } from "../audio-stream-mix";

// The wasm bundle cannot be instantiated under bun's test runner.
const TEST_TICKS_PER_SECOND = 120_000;
const unsupported = () => {
	throw new Error("not available in tests");
};
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: TEST_TICKS_PER_SECOND,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * TEST_TICKS_PER_SECOND),
	mediaTimeToSeconds: ({ time }: { time: number }) =>
		time / TEST_TICKS_PER_SECOND,
	addMediaTime: ({ a, b }: { a: number; b: number }) => a + b,
	subMediaTime: ({ a, b }: { a: number; b: number }) => a - b,
	maxMediaTime: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	minMediaTime: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
	clampMediaTime: unsupported,
	roundFrameTime: unsupported,
	roundFrameTicks: unsupported,
	snapSeekMediaTime: unsupported,
	lastFrameMediaTime: unsupported,
	parseMediaTimecode: unsupported,
}));

const { ClipAudioStream } = await import("../audio-stream-mix");

const SOURCE_RATE = 44_100;
const OUTPUT_RATE = 48_000;
const CHUNK_LENGTH = 1_000;

/**
 * A source whose left channel is its own time in seconds and whose right
 * channel is the negation. Linear interpolation is exact on it, so the mixed
 * output can be checked sample by sample.
 */
function rampSource(): AudioSourceReader {
	const sink = {
		// Mirrors mediabunny's positional `buffers(start, end)`.
		// eslint-disable-next-line opencut/prefer-object-params
		async *buffers(start: number, end: number) {
			let first = Math.floor((start * SOURCE_RATE) / CHUNK_LENGTH) * CHUNK_LENGTH;
			while (first / SOURCE_RATE < end) {
				const left = Float32Array.from(
					{ length: CHUNK_LENGTH },
					(_, i) => (first + i) / SOURCE_RATE,
				);
				const right = left.map((value) => -value);
				yield {
					timestamp: first / SOURCE_RATE,
					buffer: {
						numberOfChannels: 2,
						sampleRate: SOURCE_RATE,
						length: CHUNK_LENGTH,
						getChannelData: (channel: number) => (channel === 0 ? left : right),
					},
				};
				first += CHUNK_LENGTH;
			}
		},
	};
	// A stand-in for the mediabunny-backed reader: only `sink.buffers` is used.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return { sink } as unknown as AudioSourceReader;
}

function clip(overrides: Partial<StreamMixClip>): StreamMixClip {
	return {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		timelineElement: { animations: undefined } as unknown as StreamMixClip["timelineElement"],
		startTime: 0.25,
		duration: 1,
		trimStart: 0.5,
		volume: 0.5,
		...overrides,
	};
}

async function mixAll({
	stream,
	totalLength,
	windowLength,
}: {
	stream: InstanceType<typeof ClipAudioStream>;
	totalLength: number;
	windowLength: number;
}): Promise<[Float32Array, Float32Array]> {
	const left = new Float32Array(totalLength);
	const right = new Float32Array(totalLength);
	for (let start = 0; start < totalLength; start += windowLength) {
		const end = Math.min(totalLength, start + windowLength);
		const channels: [Float32Array, Float32Array] = [
			left.subarray(start, end),
			right.subarray(start, end),
		];
		await stream.mixInto({ channels, windowStart: start });
	}
	return [left, right];
}

describe("ClipAudioStream", () => {
	for (const rate of [1, 1.5, 0.75]) {
		test(`places, resamples and scales the clip (speed ${rate})`, async () => {
			const settings = clip({ retime: { rate } });
			const stream = new ClipAudioStream({
				clip: settings,
				outputRate: OUTPUT_RATE,
				source: rampSource(),
			});
			const totalLength = Math.ceil(1.5 * OUTPUT_RATE);
			const [left, right] = await mixAll({ stream, totalLength, windowLength: 4_800 });

			let maxError = 0;
			for (let i = 0; i < totalLength; i++) {
				const index = i - stream.outputStart;
				const inClip = index >= 0 && index < stream.renderedLength;
				const expected = inClip
					? settings.volume * (settings.trimStart + (index / OUTPUT_RATE) * rate)
					: 0;
				maxError = Math.max(
					maxError,
					Math.abs(left[i] - expected),
					Math.abs(right[i] + expected),
				);
			}
			expect(maxError).toBeLessThan(1e-5);
			await stream.close();
		});
	}

	test("gives the same result for any window size", async () => {
		const run = async (windowLength: number) =>
			mixAll({
				stream: new ClipAudioStream({
					clip: clip({ retime: { rate: 1.25 } }),
					outputRate: OUTPUT_RATE,
					source: rampSource(),
				}),
				totalLength: OUTPUT_RATE * 2,
				windowLength,
			});
		const [a] = await run(OUTPUT_RATE);
		const [b] = await run(997);
		expect(Array.from(b)).toEqual(Array.from(a));
	});
});
