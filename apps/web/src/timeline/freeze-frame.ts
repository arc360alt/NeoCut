import { BatchCommand } from "@/commands";
import type { Command } from "@/commands/base-command";
import {
	InsertElementCommand,
	ShiftTrackElementsCommand,
	SplitElementsCommand,
} from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { getSourceTimeAtClipTime } from "@/retime";
import { videoCache } from "@/services/video-cache/service";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	type MediaTime,
} from "@/wasm";
import { buildElementFromMedia } from "./element-utils";
import type {
	CreateImageElement,
	ElementRef,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "./types";

export const FREEZE_FRAME_DURATION_SECONDS = 3;

/** Audio params of the video that make no sense on a still image. */
const AUDIO_ONLY_PARAM_KEYS = new Set(["volume", "muted"]);

export interface FreezeFrameTarget {
	track: VideoTrack;
	element: VideoElement;
}

function containsTime({
	element,
	time,
}: {
	element: VideoElement;
	time: number;
}): boolean {
	return time >= element.startTime && time < element.startTime + element.duration;
}

/**
 * The video clip to freeze: the selected one under the playhead, otherwise
 * the topmost visible video clip under the playhead.
 */
export function findFreezeFrameTarget({
	tracks,
	selectedElements,
	time,
}: {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
	time: number;
}): FreezeFrameTarget | null {
	const videoTracks = [...tracks.overlay, tracks.main].filter(
		(track): track is VideoTrack => track.type === "video",
	);

	for (const selected of selectedElements) {
		const track = videoTracks.find((candidate) => candidate.id === selected.trackId);
		const element = track?.elements.find(
			(candidate) => candidate.id === selected.elementId,
		);
		if (track && element?.type === "video" && containsTime({ element, time })) {
			return { track, element };
		}
	}

	for (const track of videoTracks) {
		if (track.hidden) continue;
		const element = track.elements.find(
			(candidate): candidate is VideoElement =>
				candidate.type === "video" &&
				!candidate.hidden &&
				containsTime({ element: candidate, time }),
		);
		if (element) {
			return { track, element };
		}
	}

	return null;
}

async function captureVideoFrame({
	element,
	file,
	time,
}: {
	element: VideoElement;
	file: File;
	time: number;
}): Promise<Blob | null> {
	const sourceTime =
		element.trimStart +
		getSourceTimeAtClipTime({
			clipTime: time - element.startTime,
			retime: element.retime,
		});
	const frame = await videoCache.getFrameAt({
		mediaId: element.mediaId,
		file,
		time: mediaTimeToSeconds({ time: roundMediaTime({ time: sourceTime }) }),
	});
	if (!frame) {
		return null;
	}

	// Copy right away: the cache reuses its frame canvas for later seeks.
	const canvas = new OffscreenCanvas(frame.canvas.width, frame.canvas.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}
	ctx.drawImage(frame.canvas, 0, 0);
	return canvas.convertToBlob({ type: "image/png" });
}

function buildFreezeElement({
	element,
	mediaId,
	startTime,
	duration,
}: {
	element: VideoElement;
	mediaId: string;
	startTime: MediaTime;
	duration: MediaTime;
}): CreateImageElement | null {
	const base = buildElementFromMedia({
		mediaId,
		mediaType: "image",
		name: `${element.name} (freeze)`,
		duration,
		startTime,
	});
	if (base.type !== "image") {
		return null;
	}

	const params = Object.fromEntries(
		Object.entries(element.params).filter(
			([key]) => !AUDIO_ONLY_PARAM_KEYS.has(key),
		),
	);
	return {
		...base,
		params: { ...base.params, ...params },
		...(element.effects && { effects: element.effects }),
		...(element.masks && { masks: element.masks }),
	};
}

export type FreezeFrameResult =
	| { status: "created" }
	| { status: "no-target" }
	| { status: "failed"; reason: string };

/**
 * Inserts a still of the current frame at the playhead: the clip is split
 * there and everything after it on the same track moves later to make room.
 */
export async function freezeFrameAtPlayhead({
	editor,
	durationSeconds = FREEZE_FRAME_DURATION_SECONDS,
}: {
	editor: EditorCore;
	durationSeconds?: number;
}): Promise<FreezeFrameResult> {
	const time = editor.playback.getCurrentTime();
	const target = findFreezeFrameTarget({
		tracks: editor.scenes.getActiveScene().tracks,
		selectedElements: editor.selection.getSelectedElements(),
		time,
	});
	if (!target) {
		return { status: "no-target" };
	}

	const projectId = editor.project.getActive().metadata.id;
	const sourceAsset = editor.media
		.getAssets()
		.find((asset) => asset.id === target.element.mediaId);
	if (!sourceAsset) {
		return { status: "failed", reason: "The clip's media is missing." };
	}

	const blob = await captureVideoFrame({
		element: target.element,
		file: sourceAsset.file,
		time,
	});
	if (!blob) {
		return { status: "failed", reason: "Could not read the current frame." };
	}

	const baseName = sourceAsset.name.replace(/\.[^.]+$/, "");
	const file = new File([blob], `${baseName} freeze.png`, { type: "image/png" });
	const [processed] = await processMediaAssets({ files: [file] });
	const stillAsset = processed
		? await editor.media.addMediaAsset({ projectId, asset: processed })
		: null;
	if (!stillAsset) {
		return { status: "failed", reason: "Could not save the frame." };
	}

	const duration = mediaTimeFromSeconds({ seconds: durationSeconds });
	const freezeElement = buildFreezeElement({
		element: target.element,
		mediaId: stillAsset.id,
		startTime: time,
		duration,
	});
	if (!freezeElement) {
		return { status: "failed", reason: "Could not build the still clip." };
	}

	const commands: Command[] = [];
	if (time > target.element.startTime) {
		commands.push(
			new SplitElementsCommand({
				elements: [{ trackId: target.track.id, elementId: target.element.id }],
				splitTime: time,
			}),
		);
	}
	commands.push(
		new ShiftTrackElementsCommand({
			trackId: target.track.id,
			fromTime: time,
			offset: duration,
		}),
		new InsertElementCommand({
			element: freezeElement,
			placement: { mode: "explicit", trackId: target.track.id },
		}),
	);
	editor.command.execute({ command: new BatchCommand(commands) });
	return { status: "created" };
}
