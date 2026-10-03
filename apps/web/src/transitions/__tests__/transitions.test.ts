import { describe, expect, mock, test } from "bun:test";
import type { ImageElement, VideoTrack } from "@/timeline";
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
const {
	buildTransition,
	findDefaultTransitionTarget,
	getTransitionDefinitions,
	getTransitionWindows,
	resolveTransitionFrame,
} = await import("..");

function ticks(value: number): MediaTime {
	return mediaTime({ ticks: value });
}

function clip({
	id,
	startTime,
	duration,
	transitionDuration,
}: {
	id: string;
	startTime: number;
	duration: number;
	transitionDuration?: number;
}): ImageElement {
	return {
		id,
		type: "image",
		name: id,
		mediaId: "media",
		startTime: ticks(startTime),
		duration: ticks(duration),
		trimStart: ticks(0),
		trimEnd: ticks(0),
		params: {},
		...(transitionDuration !== undefined && {
			transitionIn: {
				type: "fade",
				duration: ticks(transitionDuration),
				params: {},
			},
		}),
	};
}

function videoTrack(elements: ImageElement[]): VideoTrack {
	return {
		id: "track",
		name: "Main",
		type: "video",
		elements,
		muted: false,
		hidden: false,
	};
}

describe("getTransitionWindows", () => {
	test("centers the transition on the cut", () => {
		const windows = getTransitionWindows({
			elements: [
				clip({ id: "a", startTime: 0, duration: 1000 }),
				clip({ id: "b", startTime: 1000, duration: 1000, transitionDuration: 200 }),
			],
		});
		expect(windows).toHaveLength(1);
		expect(windows[0]).toMatchObject({
			fromElementId: "a",
			toElementId: "b",
			cutTime: 1000,
			start: 900,
			end: 1100,
		});
	});

	test("ignores clips that do not touch", () => {
		const windows = getTransitionWindows({
			elements: [
				clip({ id: "a", startTime: 0, duration: 1000 }),
				clip({ id: "b", startTime: 1500, duration: 1000, transitionDuration: 200 }),
			],
		});
		expect(windows).toEqual([]);
	});

	test("ignores a transition on the first clip", () => {
		const windows = getTransitionWindows({
			elements: [clip({ id: "a", startTime: 0, duration: 1000, transitionDuration: 200 })],
		});
		expect(windows).toEqual([]);
	});

	test("shortens transitions so they fit the clips and never overlap", () => {
		const windows = getTransitionWindows({
			elements: [
				clip({ id: "a", startTime: 0, duration: 1000 }),
				clip({ id: "b", startTime: 1000, duration: 300, transitionDuration: 400 }),
				clip({ id: "c", startTime: 1300, duration: 1000, transitionDuration: 400 }),
			],
		});
		expect(windows).toHaveLength(2);
		const [first, second] = windows;
		expect(first).toMatchObject({ start: 800, end: 1200 });
		// b is 300 long and its first 200 already belong to the first transition.
		expect(second).toMatchObject({ start: 1200, end: 1400 });
		expect(first.end).toBeLessThanOrEqual(second.start);
	});

	test("does not depend on element order", () => {
		const windows = getTransitionWindows({
			elements: [
				clip({ id: "b", startTime: 1000, duration: 1000, transitionDuration: 200 }),
				clip({ id: "a", startTime: 0, duration: 1000 }),
			],
		});
		expect(windows).toHaveLength(1);
	});
});

describe("findDefaultTransitionTarget", () => {
	const track = videoTrack([
		clip({ id: "a", startTime: 0, duration: 1000 }),
		clip({ id: "b", startTime: 1000, duration: 1000 }),
		clip({ id: "c", startTime: 2000, duration: 1000 }),
	]);

	test("prefers the start of a selected clip", () => {
		const target = findDefaultTransitionTarget({
			tracks: [track],
			selectedElements: [{ trackId: "track", elementId: "c" }],
			playheadTime: 0,
		});
		expect(target?.cut.to.id).toBe("c");
	});

	test("falls back to the cut nearest the playhead", () => {
		const target = findDefaultTransitionTarget({
			tracks: [track],
			selectedElements: [],
			playheadTime: 1100,
		});
		expect(target?.cut.to.id).toBe("b");
	});

	test("returns null without any cut", () => {
		const target = findDefaultTransitionTarget({
			tracks: [videoTrack([clip({ id: "a", startTime: 0, duration: 1000 })])],
			selectedElements: [],
			playheadTime: 0,
		});
		expect(target).toBeNull();
	});
});

describe("transition definitions", () => {
	const definitions = getTransitionDefinitions();

	test("include the defaults", () => {
		const types = definitions.map((definition) => definition.type);
		for (const type of ["fade", "dip", "slide", "push", "wipe", "cube"]) {
			expect(types).toContain(type);
		}
	});

	for (const definition of definitions) {
		test(`${definition.type} ends fully on the incoming clip`, () => {
			const frame = resolveTransitionFrame({
				type: definition.type,
				params: {},
				progress: 1,
				width: 1920,
				height: 1080,
			});
			expect(frame).not.toBeNull();
			const to = frame?.to ?? {};
			expect(to.opacity ?? 1).toBeCloseTo(1);
			expect(to.offsetX ?? 0).toBeCloseTo(0);
			expect(to.offsetY ?? 0).toBeCloseTo(0);
			expect(to.scale ?? 1).toBeCloseTo(1);
			expect(to.rotate ?? 0).toBeCloseTo(0);
			expect(to.blur ?? 0).toBeCloseTo(0);
			expect(to.rotateY?.angle ?? 0).toBeCloseTo(0);
			expect(frame?.overlay?.opacity ?? 0).toBeCloseTo(0);
		});

		test(`${definition.type} starts fully on the outgoing clip`, () => {
			const frame = resolveTransitionFrame({
				type: definition.type,
				params: {},
				progress: 0,
				width: 1920,
				height: 1080,
			});
			const from = frame?.from ?? {};
			expect(from.opacity ?? 1).toBeCloseTo(1);
			expect(from.offsetX ?? 0).toBeCloseTo(0);
			expect(from.scale ?? 1).toBeCloseTo(1);
			expect(from.blur ?? 0).toBeCloseTo(0);
			expect(from.rotateY?.angle ?? 0).toBeCloseTo(0);
			expect(frame?.overlay?.opacity ?? 0).toBeCloseTo(0);
		});
	}

	test("buildTransition fills in default params", () => {
		const transition = buildTransition({ type: "wipe" });
		expect(transition.params).toMatchObject({ direction: "left", softness: 10 });
		expect(transition.duration).toBeGreaterThan(0);
	});
});
