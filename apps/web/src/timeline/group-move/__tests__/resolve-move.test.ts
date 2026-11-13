import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, VideoElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import type { GroupMember, MoveGroup } from "../types";

// The wasm bundle cannot be instantiated under bun's test runner.
const unsupported = () => {
	throw new Error("not available in tests");
};
mock.module("@/wasm", () => ({
	TICKS_PER_SECOND: 1,
	ZERO_MEDIA_TIME: 0,
	mediaTime: ({ ticks }: { ticks: number }) => ticks,
	roundMediaTime: ({ time }: { time: number }) => Math.round(time),
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => seconds,
	mediaTimeToSeconds: ({ time }: { time: number }) => time,
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

const { resolveGroupMove } = await import("../resolve-move");

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const t = (value: number) => value as unknown as MediaTime;

function clip({ id, start, duration }: { id: string; start: number; duration: number }): VideoElement {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "m",
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		params: {},
	};
}

// Three clips butted together on one overlay video track, above an empty main.
const tracks: SceneTracks = {
	overlay: [
		{
			id: "row",
			name: "row",
			type: "video",
			muted: false,
			hidden: false,
			elements: [
				clip({ id: "a", start: 0, duration: 5 }),
				clip({ id: "b", start: 5, duration: 3 }),
				clip({ id: "c", start: 8, duration: 4 }),
			],
		},
		{ id: "empty", name: "empty", type: "video", muted: false, hidden: false, elements: [] },
	],
	main: { id: "main", name: "main", type: "video", muted: false, hidden: false, elements: [] },
	audio: [],
};

function member({ id, offset, duration }: { id: string; offset: number; duration: number }): GroupMember {
	return {
		trackId: "row",
		elementId: id,
		elementType: "video",
		duration: t(duration),
		timeOffset: t(offset),
		trackSection: "overlay",
		sectionIndex: 0,
		displayIndex: 0,
	};
}

const members = [
	member({ id: "a", offset: 0, duration: 5 }),
	member({ id: "b", offset: 5, duration: 3 }),
	member({ id: "c", offset: 8, duration: 4 }),
];
const group: MoveGroup = { anchor: members[0], members };

describe("resolveGroupMove with clips that share a track", () => {
	test("moving to another track keeps them together on that one track", () => {
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: t(10),
			target: { kind: "existingTrack", anchorTargetTrackId: "empty" },
		});
		expect(result).not.toBeNull();
		expect(new Set(result?.moves.map((move) => move.targetTrackId))).toEqual(new Set(["empty"]));
		expect(result?.moves.map((move) => move.newStartTime)).toEqual([t(10), t(15), t(18)]);
	});

	test("moving within their own track works (no overlap with themselves)", () => {
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: t(2),
			target: { kind: "existingTrack", anchorTargetTrackId: "row" },
		});
		expect(result?.moves.every((move) => move.targetTrackId === "row")).toBe(true);
	});

	test("dropping onto new tracks creates one track, not one per clip", () => {
		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: t(0),
			target: { kind: "newTracks", anchorInsertIndex: 0, newTrackIds: ["n1", "n2", "n3"] },
		});
		expect(result?.createTracks.map((track) => track.id)).toEqual(["n1"]);
		expect(new Set(result?.moves.map((move) => move.targetTrackId))).toEqual(new Set(["n1"]));
	});
});
