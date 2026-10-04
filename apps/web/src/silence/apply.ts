import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { roundMediaTime, type MediaTime } from "@/wasm";
import type { TimeRange } from "./detect";
import type { SilenceTargetElement } from "./analyze";

export interface SilenceRemovalResult {
	tracks: SceneTracks;
	pieceIds: string[];
	removedDuration: number;
}

function sliceAnimations({
	element,
	start,
	end,
}: {
	element: SilenceTargetElement;
	start: MediaTime;
	end: MediaTime;
}): SilenceTargetElement["animations"] {
	const { rightAnimations } = splitAnimationsAtTime({
		animations: element.animations,
		splitTime: start,
	});
	const { leftAnimations } = splitAnimationsAtTime({
		animations: rightAnimations,
		splitTime: roundMediaTime({ time: end - start }),
	});
	return leftAnimations;
}

function buildPieces({
	element,
	keep,
	closeGaps,
}: {
	element: SilenceTargetElement;
	keep: TimeRange[];
	closeGaps: boolean;
}): SilenceTargetElement[] {
	const totalSourceSpan = roundMediaTime({
		time: getSourceSpanAtClipTime({
			clipTime: element.duration,
			retime: element.retime,
		}),
	});

	let keptBefore = 0;
	return keep.map((range, index) => {
		const start = roundMediaTime({ time: range.start });
		const end = roundMediaTime({ time: range.end });
		const sourceStart = roundMediaTime({
			time: getSourceSpanAtClipTime({ clipTime: start, retime: element.retime }),
		});
		const sourceEnd = roundMediaTime({
			time: getSourceSpanAtClipTime({ clipTime: end, retime: element.retime }),
		});
		const startTime = roundMediaTime({
			time: element.startTime + (closeGaps ? keptBefore : start),
		});
		keptBefore += end - start;

		const piece: SilenceTargetElement = {
			...element,
			id: index === 0 ? element.id : generateUUID(),
			startTime,
			duration: roundMediaTime({ time: end - start }),
			trimStart: roundMediaTime({ time: element.trimStart + sourceStart }),
			trimEnd: roundMediaTime({
				time: element.trimEnd + (totalSourceSpan - sourceEnd),
			}),
			animations: sliceAnimations({ element, start, end }),
		};
		// Only the first piece can still sit right after the previous clip.
		if (piece.type === "video" && (index > 0 || start > 0)) {
			piece.transitionIn = undefined;
		}
		return piece;
	});
}

/**
 * Replaces a clip with the parts of it to keep. With `closeGaps`, the parts
 * are pushed together and everything after the clip on the same track moves
 * left by the removed time.
 *
 * `keep` is in clip time (ticks from the clip's start), sorted and
 * non-overlapping. Returns null when nothing would be removed.
 */
export function buildSilenceRemoval({
	tracks,
	trackId,
	elementId,
	keep,
	closeGaps,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
	keep: TimeRange[];
	closeGaps: boolean;
}): SilenceRemovalResult | null {
	const allTracks: TimelineTrack[] = [...tracks.overlay, tracks.main, ...tracks.audio];
	const track = allTracks.find((candidate) => candidate.id === trackId);
	const element = track?.elements.find((candidate) => candidate.id === elementId);
	if (!track || !element || (element.type !== "video" && element.type !== "audio")) {
		return null;
	}

	const validKeep = keep
		.map((range) => ({
			start: Math.max(0, Math.min(element.duration, range.start)),
			end: Math.max(0, Math.min(element.duration, range.end)),
		}))
		.filter((range) => roundMediaTime({ time: range.end - range.start }) > 0);
	const keptDuration = validKeep.reduce(
		(total, range) => total + (range.end - range.start),
		0,
	);
	const removedDuration = element.duration - keptDuration;
	if (validKeep.length === 0 || removedDuration <= 0) {
		return null;
	}

	const pieces = buildPieces({ element, keep: validKeep, closeGaps });
	const clipEnd = element.startTime + element.duration;
	const shift = closeGaps ? roundMediaTime({ time: removedDuration }) : 0;

	const updateTrack = <TTrack extends TimelineTrack>(candidate: TTrack): TTrack => {
		if (candidate.id !== trackId) {
			return candidate;
		}
		const elements: TimelineElement[] = candidate.elements.flatMap(
			(item: TimelineElement) => {
				if (item.id === elementId) {
					return pieces;
				}
				if (shift > 0 && item.startTime >= clipEnd) {
					return [{ ...item, startTime: roundMediaTime({ time: item.startTime - shift }) }];
				}
				return [item];
			},
		);
		return { ...candidate, elements } as TTrack;
	};

	return {
		tracks: {
			overlay: tracks.overlay.map(updateTrack),
			main: updateTrack(tracks.main),
			audio: tracks.audio.map(updateTrack),
		},
		pieceIds: pieces.map((piece) => piece.id),
		removedDuration,
	};
}
