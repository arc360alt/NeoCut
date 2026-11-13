import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import type {
	AudioTrack,
	CompoundElement,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	TScene,
	VideoTrack,
} from "@/timeline";
import { addMediaTime, mediaTime, roundMediaTime, subMediaTime, type MediaTime } from "@/wasm";

/** Compound clips inside compound clips are followed this deep. */
const MAX_DEPTH = 8;

/**
 * Replaces every compound clip with the contents of the scene it plays,
 * placed where the clip is on the timeline and cut to its range. Rendering,
 * playback and export work on the result, so they need no notion of
 * compound clips.
 *
 * The nested scene's tracks are inserted at the compound clip's own layer
 * (overlay tracks are stored top first), and its audio tracks are added to
 * the audio tracks.
 */
export function flattenCompoundTracks({
	tracks,
	scenes,
}: {
	tracks: SceneTracks;
	scenes: readonly TScene[];
}): SceneTracks {
	if (!hasCompound({ tracks })) {
		return tracks;
	}
	return flatten({
		tracks,
		scenesById: new Map(scenes.map((scene) => [scene.id, scene])),
		visiting: new Set(),
		depth: 0,
	});
}

function hasCompound({ tracks }: { tracks: SceneTracks }): boolean {
	return [tracks.main, ...tracks.overlay].some(
		(track) =>
			track.type === "video" && track.elements.some((element) => element.type === "compound"),
	);
}

interface Expansion {
	overlay: OverlayTrack[];
	audio: AudioTrack[];
}

function flatten({
	tracks,
	scenesById,
	visiting,
	depth,
}: {
	tracks: SceneTracks;
	scenesById: Map<string, TScene>;
	visiting: Set<string>;
	depth: number;
}): SceneTracks {
	const extraAudio: AudioTrack[] = [];

	const expandTrack = ({ track }: { track: VideoTrack }): { track: VideoTrack; above: OverlayTrack[] } => {
		const compounds = track.elements.filter(
			(element): element is CompoundElement => element.type === "compound",
		);
		if (compounds.length === 0) {
			return { track, above: [] };
		}
		const above: OverlayTrack[] = [];
		for (const compound of compounds) {
			const expansion = expandCompound({
				compound,
				hostTrack: track,
				scenesById,
				visiting,
				depth,
			});
			above.push(...expansion.overlay);
			extraAudio.push(...expansion.audio);
		}
		return {
			track: {
				...track,
				elements: track.elements.filter((element) => element.type !== "compound"),
			},
			above,
		};
	};

	const overlay: OverlayTrack[] = [];
	for (const track of tracks.overlay) {
		if (track.type !== "video") {
			overlay.push(track);
			continue;
		}
		const { track: expanded, above } = expandTrack({ track });
		overlay.push(...above, expanded);
	}
	const { track: main, above: aboveMain } = expandTrack({ track: tracks.main });
	overlay.push(...aboveMain);

	return { overlay, main, audio: [...tracks.audio, ...extraAudio] };
}

function expandCompound({
	compound,
	hostTrack,
	scenesById,
	visiting,
	depth,
}: {
	compound: CompoundElement;
	hostTrack: VideoTrack;
	scenesById: Map<string, TScene>;
	visiting: Set<string>;
	depth: number;
}): Expansion {
	const scene = scenesById.get(compound.sceneId);
	// A missing scene, a scene that (indirectly) contains itself, or nesting
	// past the limit plays as nothing rather than looping forever.
	if (!scene || visiting.has(scene.id) || depth >= MAX_DEPTH) {
		return { overlay: [], audio: [] };
	}

	visiting.add(scene.id);
	const inner = flatten({ tracks: scene.tracks, scenesById, visiting, depth: depth + 1 });
	visiting.delete(scene.id);

	const isHidden = compound.hidden === true || hostTrack.hidden;
	const isMuted = compound.muted === true || hostTrack.muted;
	const place = <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
		({
			...track,
			id: `${compound.id}/${track.id}`,
			elements: track.elements.flatMap((element) => {
				const placed = placeElement({ element, compound });
				return placed ? [placed] : [];
			}),
		}) as TTrack;

	const visualTracks: OverlayTrack[] = isHidden
		? []
		: [...inner.overlay, inner.main].map((track) => {
				const placed = place(track);
				// The nested main track's own audio follows the compound clip's.
				return placed.type === "video" && isMuted ? { ...placed, muted: true } : placed;
			});
	const audioTracks = isMuted ? [] : inner.audio.map((track) => place(track));

	return {
		overlay: visualTracks.filter((track) => track.elements.length > 0),
		audio: audioTracks.filter((track) => track.elements.length > 0),
	};
}

/**
 * The scene element as it appears inside the compound clip: shifted to the
 * clip's timeline position and cut to the part of the scene the clip shows.
 */
function placeElement({
	element,
	compound,
}: {
	element: TimelineElement;
	compound: CompoundElement;
}): TimelineElement | null {
	const windowStart = compound.trimStart;
	const windowEnd = addMediaTime({ a: compound.trimStart, b: compound.duration });
	const elementEnd = addMediaTime({ a: element.startTime, b: element.duration });
	if (elementEnd <= windowStart || element.startTime >= windowEnd) {
		return null;
	}

	const headCut =
		element.startTime < windowStart
			? subMediaTime({ a: windowStart, b: element.startTime })
			: mediaTime({ ticks: 0 });
	const tailCut =
		elementEnd > windowEnd ? subMediaTime({ a: elementEnd, b: windowEnd }) : mediaTime({ ticks: 0 });
	const clipped = clipElement({ element, headCut, tailCut });

	const offset = subMediaTime({ a: compound.startTime, b: windowStart });
	return {
		...clipped,
		id: `${compound.id}/${element.id}`,
		startTime: addMediaTime({ a: clipped.startTime, b: offset }),
		// Outermost first. Compound clips this one was already inside move by
		// the same offset, so their keyframes stay in step with it.
		compoundParents: [
			compound,
			...(element.compoundParents ?? []).map((parent) => ({
				...parent,
				startTime: addMediaTime({ a: parent.startTime, b: offset }),
			})),
		],
	};
}

/** Cuts `headCut` off the start and `tailCut` off the end, as a split would. */
function clipElement({
	element,
	headCut,
	tailCut,
}: {
	element: TimelineElement;
	headCut: MediaTime;
	tailCut: MediaTime;
}): TimelineElement {
	if (headCut <= 0 && tailCut <= 0) {
		return element;
	}
	const retime = "retime" in element ? element.retime : undefined;
	const sourceSpan = (clipTime: MediaTime) =>
		roundMediaTime({ time: getSourceSpanAtClipTime({ clipTime, retime }) });

	let animations = element.animations;
	if (headCut > 0) {
		// Keyframe times are local to the clip; keep the part after the cut,
		// re-based so the animation continues instead of restarting.
		animations = splitAnimationsAtTime({
			animations,
			splitTime: headCut,
			shouldIncludeSplitBoundary: true,
		}).rightAnimations;
	}

	const duration = subMediaTime({
		a: subMediaTime({ a: element.duration, b: headCut }),
		b: tailCut,
	});
	return {
		...element,
		startTime: addMediaTime({ a: element.startTime, b: headCut }),
		duration,
		trimStart: addMediaTime({ a: element.trimStart, b: sourceSpan(headCut) }),
		trimEnd: addMediaTime({ a: element.trimEnd, b: sourceSpan(tailCut) }),
		animations,
		// The cut start isn't a cut between clips; drop the transition there.
		...(headCut > 0 && "transitionIn" in element ? { transitionIn: undefined } : {}),
	} as TimelineElement;
}
