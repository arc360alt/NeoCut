import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement, VideoTrack } from "@/timeline";
import type { MediaTime } from "@/wasm";

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

const { mediaTime } = await import("@/wasm");
const { LevelMeter, findSilence, LEVEL_WINDOW_SECONDS } = await import("../detect");
const { buildSilenceRemoval } = await import("../apply");

const T = TEST_TICKS_PER_SECOND;
const ticks = (value: number): MediaTime => mediaTime({ ticks: value });

/** One level per window: loud (-10 dB) or silent (-90 dB) by second. */
function levelsFor({ pattern }: { pattern: Array<"loud" | "quiet"> }): number[] {
	const perSecond = Math.round(1 / LEVEL_WINDOW_SECONDS);
	return pattern.flatMap((kind) =>
		Array.from({ length: perSecond }, () => (kind === "loud" ? -10 : -90)),
	);
}

describe("LevelMeter", () => {
	test("measures a full-scale square wave at 0 dB and silence at the floor", () => {
		const meter = new LevelMeter({ sampleRate: 1000 });
		const loud = new Float32Array(meter.windowSize).fill(1);
		const quiet = new Float32Array(meter.windowSize);
		meter.push({ channels: [loud] });
		meter.push({ channels: [quiet] });
		const levels = meter.finish();
		expect(levels[0]).toBeCloseTo(0);
		expect(levels[1]).toBe(-100);
	});

	test("windows span chunk boundaries", () => {
		const meter = new LevelMeter({ sampleRate: 1000 });
		const half = new Float32Array(meter.windowSize / 2).fill(0.5);
		meter.push({ channels: [half] });
		meter.push({ channels: [half] });
		expect(meter.finish()).toHaveLength(1);
	});
});

describe("findSilence", () => {
	const settings = { thresholdDb: -40, minSilenceSeconds: 0.5, paddingSeconds: 0.1 };

	test("removes long quiet stretches, padded away from the sound", () => {
		const result = findSilence({
			levels: levelsFor({ pattern: ["loud", "quiet", "quiet", "loud"] }),
			duration: 4,
			settings,
		});
		expect(result.silent).toHaveLength(1);
		expect(result.silent[0].start).toBeCloseTo(1.1);
		expect(result.silent[0].end).toBeCloseTo(2.9);
		expect(result.keep.map((r) => [r.start, r.end])).toEqual([
			[0, expect.closeTo(1.1)],
			[expect.closeTo(2.9), 4],
		]);
	});

	test("keeps pauses shorter than the minimum", () => {
		const result = findSilence({
			levels: levelsFor({ pattern: ["loud", "quiet", "loud"] }),
			duration: 3,
			settings: { ...settings, minSilenceSeconds: 1.5 },
		});
		expect(result.silent).toEqual([]);
		expect(result.keep).toEqual([{ start: 0, end: 3 }]);
	});

	test("does not pad at the clip edges", () => {
		const result = findSilence({
			levels: levelsFor({ pattern: ["quiet", "loud", "quiet"] }),
			duration: 3,
			settings,
		});
		expect(result.silent[0].start).toBe(0);
		expect(result.silent[0].end).toBeCloseTo(0.9);
		expect(result.silent[1].start).toBeCloseTo(2.1);
		expect(result.silent[1].end).toBe(3);
	});
});

function videoClip(overrides: Partial<VideoElement>): VideoElement {
	return {
		id: "clip",
		type: "video",
		name: "clip",
		mediaId: "media",
		startTime: ticks(0),
		duration: ticks(10 * T),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: {},
		...overrides,
	};
}

function sceneWith({ elements }: { elements: VideoElement[] }): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "Main",
		type: "video",
		elements,
		muted: false,
		hidden: false,
	};
	return { overlay: [], main, audio: [] };
}

describe("buildSilenceRemoval", () => {
	const keep = [
		{ start: 0, end: 2 * T },
		{ start: 5 * T, end: 10 * T },
	];

	test("splits the clip into kept pieces with matching trims", () => {
		const result = buildSilenceRemoval({
			tracks: sceneWith({ elements: [videoClip({ trimStart: ticks(1 * T), trimEnd: ticks(1 * T) })] }),
			trackId: "main",
			elementId: "clip",
			keep,
			closeGaps: false,
		});
		const pieces = result?.tracks.main.elements ?? [];
		expect(pieces.map((p) => [p.startTime, p.duration, p.trimStart, p.trimEnd])).toEqual([
			[0, 2 * T, 1 * T, 9 * T],
			[5 * T, 5 * T, 6 * T, 1 * T],
		]);
		expect(pieces[0].id).toBe("clip");
		expect(result?.removedDuration).toBe(3 * T);
	});

	test("closing gaps pulls pieces and later clips left", () => {
		const result = buildSilenceRemoval({
			tracks: sceneWith({
				elements: [videoClip({}), videoClip({ id: "next", startTime: ticks(10 * T) })],
			}),
			trackId: "main",
			elementId: "clip",
			keep,
			closeGaps: true,
		});
		const elements = result?.tracks.main.elements ?? [];
		expect(elements.map((e) => [e.id === "next" ? "next" : "piece", e.startTime])).toEqual([
			["piece", 0],
			["piece", 2 * T],
			["next", 7 * T],
		]);
	});

	test("maps through speed changes", () => {
		const result = buildSilenceRemoval({
			tracks: sceneWith({ elements: [videoClip({ retime: { rate: 2 } })] }),
			trackId: "main",
			elementId: "clip",
			keep,
			closeGaps: false,
		});
		const second = result?.tracks.main.elements[1];
		// 5s into a 2x clip is 10s into the source; the clip covers 20s of it.
		expect(second?.trimStart).toBe(10 * T);
		expect(second?.trimEnd).toBe(0);
	});

	test("only the first piece keeps a transition into the clip", () => {
		const result = buildSilenceRemoval({
			tracks: sceneWith({
				elements: [
					videoClip({
						transitionIn: { type: "fade", duration: ticks(T / 2), params: {} },
					}),
				],
			}),
			trackId: "main",
			elementId: "clip",
			keep,
			closeGaps: false,
		});
		const [first, second] = (result?.tracks.main.elements ?? []).filter(
			(element): element is VideoElement => element.type === "video",
		);
		expect(first.transitionIn?.type).toBe("fade");
		expect(second.transitionIn).toBeUndefined();
	});

	test("returns null when nothing would be removed", () => {
		expect(
			buildSilenceRemoval({
				tracks: sceneWith({ elements: [videoClip({})] }),
				trackId: "main",
				elementId: "clip",
				keep: [{ start: 0, end: 10 * T }],
				closeGaps: true,
			}),
		).toBeNull();
	});
});
