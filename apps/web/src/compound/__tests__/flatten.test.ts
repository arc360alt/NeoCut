/* eslint-disable opencut/prefer-object-params -- short positional fixture builders keep the cases readable */
import { describe, expect, mock, test } from "bun:test";
import type {
	AudioElement,
	CompoundElement,
	SceneTracks,
	TextElement,
	TimelineElement,
	TScene,
	VideoElement,
} from "@/timeline";
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
	mediaTimeToSeconds: ({ time }: { time: number }) => time / TEST_TICKS_PER_SECOND,
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

const { flattenCompoundTracks } = await import("../flatten");
const { buildCompoundFromSelection } = await import("../create");
const { composeTransforms } = await import("../compose");

// Casts stand in for wasm's branded MediaTime, which tests can't construct.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const s = (seconds: number) => (seconds * TEST_TICKS_PER_SECOND) as unknown as MediaTime;

function base(id: string, start: number, duration: number) {
	return {
		id,
		name: id,
		startTime: s(start),
		duration: s(duration),
		trimStart: s(0),
		trimEnd: s(0),
		params: {},
	};
}

function text(id: string, start: number, duration: number): TextElement {
	return { ...base(id, start, duration), type: "text" };
}

function video(id: string, start: number, duration: number, rate = 1): VideoElement {
	return {
		...base(id, start, duration),
		type: "video",
		mediaId: `media-${id}`,
		...(rate !== 1 ? { retime: { rate } } : {}),
	};
}

function audio(id: string, start: number, duration: number): AudioElement {
	return { ...base(id, start, duration), type: "audio", sourceType: "upload", mediaId: `m-${id}` };
}

function compound(id: string, sceneId: string, start: number, duration: number, sceneOffset = 0): CompoundElement {
	return { ...base(id, start, duration), type: "compound", sceneId, trimStart: s(sceneOffset) };
}

function tracks({
	overlayVideo = [],
	overlayText = [],
	main = [],
	audioElements = [],
}: {
	overlayVideo?: (VideoElement | CompoundElement)[];
	overlayText?: TextElement[];
	main?: (VideoElement | CompoundElement)[];
	audioElements?: AudioElement[];
}): SceneTracks {
	return {
		overlay: [
			...(overlayText.length ? [{ id: "t", name: "t", type: "text" as const, elements: overlayText, hidden: false }] : []),
			...(overlayVideo.length ? [{ id: "ov", name: "ov", type: "video" as const, elements: overlayVideo, muted: false, hidden: false }] : []),
		],
		main: { id: "main", name: "main", type: "video", elements: main, muted: false, hidden: false },
		audio: audioElements.length ? [{ id: "a", name: "a", type: "audio", elements: audioElements, muted: false }] : [],
	};
}

function scene(id: string, sceneTracks: SceneTracks): TScene {
	return { id, name: id, isMain: false, tracks: sceneTracks, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) };
}

const seconds = (time: number) => time / TEST_TICKS_PER_SECOND;
const elementsOf = (list: readonly { elements: readonly TimelineElement[] }[]): TimelineElement[] =>
	list.flatMap((track) => [...track.elements]);

describe("flattenCompoundTracks", () => {
	test("returns the same tracks when there is no compound clip", () => {
		const input = tracks({ main: [video("v", 0, 5)] });
		expect(flattenCompoundTracks({ tracks: input, scenes: [] })).toBe(input);
	});

	test("places the scene's clips at the compound clip and cuts them to its range", () => {
		// The clip shows scene time 2s–5s, placed at timeline 10s.
		const inner = scene("inner", tracks({ overlayText: [text("title", 0, 4)], main: [video("bg", 1, 8)], audioElements: [audio("music", 1, 6)] }));
		const result = flattenCompoundTracks({
			tracks: tracks({ main: [compound("c", "inner", 10, 3, 2)] }),
			scenes: [inner],
		});

		expect(result.main.elements).toHaveLength(0);
		const placed = elementsOf(result.overlay);
		const title = placed.find((element) => element.id === "c/title");
		const background = placed.find((element) => element.id === "c/bg");
		// title: scene 0–4s → visible 2–4s → timeline 10–12s
		expect(seconds(title?.startTime ?? -1)).toBe(10);
		expect(seconds(title?.duration ?? -1)).toBe(2);
		// background video: scene 1–9s → visible 2–5s → timeline 10–13s, 1s trimmed from its start
		expect(seconds(background?.startTime ?? -1)).toBe(10);
		expect(seconds(background?.duration ?? -1)).toBe(3);
		expect(seconds(background?.trimStart ?? -1)).toBe(1);
		expect(seconds(background?.trimEnd ?? -1)).toBe(4);

		const music = elementsOf(result.audio).find((element) => element.id === "c/music");
		expect(seconds(music?.startTime ?? -1)).toBe(10);
		expect(seconds(music?.duration ?? -1)).toBe(3);
		expect(seconds(music?.trimStart ?? -1)).toBe(1);
	});

	test("trims source time by the clip's speed", () => {
		const inner = scene("inner", tracks({ main: [video("fast", 0, 4, 2)] }));
		const result = flattenCompoundTracks({ tracks: tracks({ main: [compound("c", "inner", 0, 2, 1)] }), scenes: [inner] });
		const clip = elementsOf(result.overlay)[0];
		// 1s of timeline cut from the head at 2x speed is 2s of source.
		expect(seconds(clip.trimStart)).toBe(2);
	});

	test("inserts the scene's layers at the compound clip's layer", () => {
		const inner = scene("inner", tracks({ main: [video("inside", 0, 2)] }));
		const result = flattenCompoundTracks({
			tracks: tracks({ overlayText: [text("top", 0, 2)], overlayVideo: [compound("c", "inner", 0, 2)], main: [video("bottom", 0, 2)] }),
			scenes: [inner],
		});
		expect(result.overlay.map((track) => track.elements.map((element) => element.id))).toEqual([
			["top"],
			["c/inside"],
			[],
		]);
		expect(result.main.elements.map((element) => element.id)).toEqual(["bottom"]);
	});

	test("a muted compound clip contributes no audio", () => {
		const inner = scene("inner", tracks({ main: [video("v", 0, 2)], audioElements: [audio("music", 0, 2)] }));
		const muted = { ...compound("c", "inner", 0, 2), muted: true };
		const result = flattenCompoundTracks({ tracks: tracks({ main: [muted] }), scenes: [inner] });
		expect(result.audio).toHaveLength(0);
		expect(result.overlay.every((track) => track.type !== "video" || track.muted)).toBe(true);
	});

	test("a scene that contains itself plays once instead of looping forever", () => {
		const loop = scene("loop", tracks({ main: [compound("self", "loop", 0, 2)], overlayText: [text("t", 0, 2)] }));
		const result = flattenCompoundTracks({ tracks: tracks({ main: [compound("c", "loop", 0, 2)] }), scenes: [loop] });
		const ids = elementsOf(result.overlay).map((element) => element.id);
		expect(ids).toEqual(["c/t"]);
	});
});

describe("buildCompoundFromSelection", () => {
	const source = () =>
		tracks({
			overlayText: [text("title", 2, 3)],
			overlayVideo: [video("broll", 8, 2)],
			main: [video("intro", 0, 2), video("talk", 2, 4)],
			audioElements: [audio("music", 2, 4)],
		});
	const refs = (...ids: string[]) => ids.map((elementId) => ({ trackId: "?", elementId }));

	test("moves the clips into the new scene, starting at 0 on their own tracks", () => {
		const result = buildCompoundFromSelection({ tracks: source(), selected: refs("title", "talk", "music"), sceneId: "sc", name: "Compound 1" });
		if (!result) throw new Error("expected a result");
		const inner = result.innerTracks;
		expect(inner.overlay.map((track) => track.type)).toEqual(["text"]);
		expect(elementsOf(inner.overlay).map((element) => [element.id, seconds(element.startTime)])).toEqual([["title", 0]]);
		expect(inner.main.elements.map((element) => [element.id, seconds(element.startTime)])).toEqual([["talk", 0]]);
		expect(elementsOf(inner.audio).map((element) => element.id)).toEqual(["music"]);
		expect(seconds(result.compound.startTime)).toBe(2);
		expect(seconds(result.compound.duration)).toBe(4);
	});

	test("puts the compound clip where the clips were and drops emptied tracks", () => {
		const result = buildCompoundFromSelection({ tracks: source(), selected: refs("title", "talk", "music"), sceneId: "sc", name: "Compound 1" });
		if (!result) throw new Error("expected a result");
		const outer = result.outerTracks;
		// The text track and audio track only held moved clips.
		expect(outer.overlay.map((track) => track.type)).toEqual(["video"]);
		expect(outer.audio).toHaveLength(0);
		// Only main-track video was picked, and main is free over 2–6s: it goes there.
		expect(outer.main.elements.map((element) => element.id)).toEqual(["intro", result.compound.id]);
		expect(result.compoundTrackId).toBe("main");
	});

	test("uses a new video track when the span isn't free", () => {
		// broll (8–10s) stays; selecting intro + title spans 0–5s on main, but
		// "talk" (2–6s) remains there, so main isn't free.
		const result = buildCompoundFromSelection({ tracks: source(), selected: refs("intro", "title"), sceneId: "sc", name: "C" });
		if (!result) throw new Error("expected a result");
		const host = result.outerTracks.overlay.find((track) => track.id === result.compoundTrackId);
		expect(host?.type).toBe("video");
		expect(host?.elements.map((element) => element.id)).toEqual([result.compound.id]);
		// The new track sits where the text track was: above the b-roll track.
		expect(result.outerTracks.overlay[0].id).toBe(result.compoundTrackId);
	});

	test("flattening the result plays the same clips at the same times", () => {
		const original = source();
		const result = buildCompoundFromSelection({ tracks: original, selected: refs("title", "talk", "music"), sceneId: "sc", name: "C" });
		if (!result) throw new Error("expected a result");
		const flat = flattenCompoundTracks({ tracks: result.outerTracks, scenes: [scene("sc", result.innerTracks)] });
		const timing = (list: TimelineElement[]) =>
			list
				.map((element) => `${element.id.split("/").pop()}@${seconds(element.startTime)}+${seconds(element.duration)}`)
				.sort();
		const before = timing([...elementsOf(original.overlay), ...original.main.elements, ...elementsOf(original.audio)]);
		const after = timing([...elementsOf(flat.overlay), ...flat.main.elements, ...elementsOf(flat.audio)]);
		expect(after).toEqual(before);
	});
});

describe("composeTransforms", () => {
	const t = (x: number, y: number, scale: number, rotate: number) => ({
		position: { x, y },
		scaleX: scale,
		scaleY: scale,
		rotate,
	});

	test("an identity parent leaves the child unchanged", () => {
		expect(composeTransforms({ parent: t(0, 0, 1, 0), child: t(30, -20, 1.5, 10) })).toEqual(t(30, -20, 1.5, 10));
	});

	test("the parent scales, rotates, then moves the child's offset", () => {
		const result = composeTransforms({ parent: t(100, 0, 2, 90), child: t(10, 0, 1, 15) });
		expect(result.position.x).toBeCloseTo(100);
		expect(result.position.y).toBeCloseTo(20);
		expect(result.scaleX).toBe(2);
		expect(result.rotate).toBe(105);
	});
});

describe("compound ancestry", () => {
	test("inner clips record their compound clips, outermost first, at matching times", () => {
		const innermost = scene("inner", tracks({ overlayText: [text("t", 0, 2)] }));
		const middle = scene("middle", tracks({ main: [compound("ci", "inner", 1, 2)] }));
		const result = flattenCompoundTracks({
			tracks: tracks({ main: [compound("co", "middle", 10, 3)] }),
			scenes: [innermost, middle],
		});
		const placed = elementsOf(result.overlay).find((element) => element.id === "co/ci/t");
		expect(placed?.compoundParents?.map((parent) => parent.id)).toEqual(["co", "ci"]);
		// "ci" starts 1s into the middle scene, which starts at 10s.
		expect(seconds(placed?.compoundParents?.[1].startTime ?? -1)).toBe(11);
		expect(seconds(placed?.startTime ?? -1)).toBe(11);
	});
});
