import type {
	ElementTransition,
	TimelineElement,
	TimelineTrack,
	TransitionableElement,
} from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";

/** Clips closer than this are treated as touching. */
const ADJACENCY_TOLERANCE_TICKS = Math.round(TICKS_PER_SECOND / 1000);

export interface TransitionWindow {
	fromElementId: string;
	toElementId: string;
	cutTime: number;
	/** Timeline time the transition starts, before the cut. */
	start: number;
	/** Timeline time the transition ends, after the cut. */
	end: number;
	transition: ElementTransition;
}

export interface TrackCut {
	from: TransitionableElement;
	to: TransitionableElement;
	cutTime: number;
}

export function isTransitionableElement(
	element: TimelineElement,
): element is TransitionableElement {
	return element.type === "video" || element.type === "image";
}

export function canTrackHaveTransitions({
	track,
}: {
	track: TimelineTrack;
}): boolean {
	return track.type === "video";
}

function sortByStartTime<T extends TimelineElement>(elements: T[]): T[] {
	return elements.slice().sort((a, b) => {
		if (a.startTime !== b.startTime) return a.startTime - b.startTime;
		return a.id.localeCompare(b.id);
	});
}

/** Every point where one clip ends exactly where the next one starts. */
export function getTrackCuts({
	elements,
}: {
	elements: TimelineElement[];
}): TrackCut[] {
	const sorted = sortByStartTime(elements);
	const cuts: TrackCut[] = [];
	for (let index = 1; index < sorted.length; index++) {
		const from = sorted[index - 1];
		const to = sorted[index];
		if (!isTransitionableElement(from) || !isTransitionableElement(to)) {
			continue;
		}
		const fromEnd = from.startTime + from.duration;
		if (Math.abs(fromEnd - to.startTime) > ADJACENCY_TOLERANCE_TICKS) {
			continue;
		}
		cuts.push({ from, to, cutTime: to.startTime });
	}
	return cuts;
}

/**
 * The time span each transition on a track occupies. Each transition is
 * centered on its cut and shortened when needed so that it fits inside both
 * clips and never overlaps the neighbouring transition on the same clip.
 */
export function getTransitionWindows({
	elements,
}: {
	elements: TimelineElement[];
}): TransitionWindow[] {
	const windows: TransitionWindow[] = [];
	const usedLeadIn = new Map<string, number>();

	for (const cut of getTrackCuts({ elements })) {
		const transition = cut.to.transitionIn;
		if (!transition || transition.duration <= 0) {
			continue;
		}

		const availableBefore =
			cut.from.duration - (usedLeadIn.get(cut.from.id) ?? 0);
		const availableAfter = cut.to.duration;
		const halfDuration = Math.min(
			transition.duration / 2,
			availableBefore,
			availableAfter,
		);
		if (halfDuration <= 0) {
			continue;
		}

		usedLeadIn.set(cut.to.id, halfDuration);
		windows.push({
			fromElementId: cut.from.id,
			toElementId: cut.to.id,
			cutTime: cut.cutTime,
			start: cut.cutTime - halfDuration,
			end: cut.cutTime + halfDuration,
			transition,
		});
	}

	return windows;
}

export function findCutNearTime({
	track,
	time,
	maxDistance,
}: {
	track: TimelineTrack;
	time: number;
	maxDistance: number;
}): TrackCut | null {
	if (!canTrackHaveTransitions({ track })) {
		return null;
	}

	let nearest: TrackCut | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const cut of getTrackCuts({ elements: track.elements })) {
		const distance = Math.abs(cut.cutTime - time);
		if (distance <= maxDistance && distance < nearestDistance) {
			nearest = cut;
			nearestDistance = distance;
		}
	}
	return nearest;
}

/**
 * Where a transition added without dragging should go: the start of a
 * selected clip if another clip ends there, otherwise the cut closest to the
 * playhead on any video track.
 */
export function findDefaultTransitionTarget({
	tracks,
	selectedElements,
	playheadTime,
}: {
	tracks: TimelineTrack[];
	selectedElements: { trackId: string; elementId: string }[];
	playheadTime: number;
}): { trackId: string; cut: TrackCut } | null {
	for (const selected of selectedElements) {
		const track = tracks.find((candidate) => candidate.id === selected.trackId);
		if (!track || !canTrackHaveTransitions({ track })) {
			continue;
		}
		const cut = getTrackCuts({ elements: track.elements }).find(
			(candidate) => candidate.to.id === selected.elementId,
		);
		if (cut) {
			return { trackId: track.id, cut };
		}
	}

	let nearest: { trackId: string; cut: TrackCut } | null = null;
	for (const track of tracks) {
		const cut = findCutNearTime({
			track,
			time: playheadTime,
			maxDistance: Number.POSITIVE_INFINITY,
		});
		if (
			cut &&
			(!nearest ||
				Math.abs(cut.cutTime - playheadTime) <
					Math.abs(nearest.cut.cutTime - playheadTime))
		) {
			nearest = { trackId: track.id, cut };
		}
	}
	return nearest;
}
