import type {
	AudioTrack,
	CompoundElement,
	ElementRef,
	OverlayTrack,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { addMediaTime, mediaTime, subMediaTime, type MediaTime } from "@/wasm";

export interface CompoundFromSelection {
	/** Tracks of the new scene: the selected clips, starting at 0. */
	innerTracks: SceneTracks;
	/** The current scene's tracks with the clips replaced by the compound clip. */
	outerTracks: SceneTracks;
	compound: CompoundElement;
	compoundTrackId: string;
}

/**
 * Moves the selected clips into a new scene's tracks and puts one compound
 * clip, spanning them, in their place. Each clip keeps its track (so its
 * layer) and its timing relative to the others.
 *
 * Pure: the caller creates the scene and applies the tracks.
 */
export function buildCompoundFromSelection({
	tracks,
	selected,
	sceneId,
	name,
}: {
	tracks: SceneTracks;
	selected: readonly ElementRef[];
	sceneId: string;
	name: string;
}): CompoundFromSelection | null {
	const selectedIds = new Set(selected.map((ref) => ref.elementId));
	const isSelected = (element: TimelineElement) => selectedIds.has(element.id);
	const allTracks: TimelineTrack[] = [...tracks.overlay, tracks.main, ...tracks.audio];
	const picked = allTracks.flatMap((track) => track.elements.filter(isSelected));
	if (picked.length === 0) {
		return null;
	}

	const start = picked.reduce(
		(earliest, element) => (element.startTime < earliest ? element.startTime : earliest),
		picked[0].startTime,
	);
	const end = picked.reduce((latest, element) => {
		const elementEnd = addMediaTime({ a: element.startTime, b: element.duration });
		return elementEnd > latest ? elementEnd : latest;
	}, addMediaTime({ a: picked[0].startTime, b: picked[0].duration }));
	const duration = subMediaTime({ a: end, b: start });

	const shift = (element: TimelineElement): TimelineElement => ({
		...element,
		startTime: subMediaTime({ a: element.startTime, b: start }),
	});
	const innerCopy = <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
		({
			...track,
			id: generateUUID(),
			elements: track.elements.filter(isSelected).map(shift),
		}) as TTrack;
	const without = <TTrack extends TimelineTrack>(track: TTrack): TTrack =>
		({ ...track, elements: track.elements.filter((element) => !isSelected(element)) }) as TTrack;
	const hadSelection = (track: TimelineTrack) => track.elements.some(isSelected);

	const innerTracks: SceneTracks = {
		overlay: tracks.overlay.filter(hadSelection).map(innerCopy),
		main: { ...innerCopy(tracks.main), name: tracks.main.name },
		audio: tracks.audio.filter(hadSelection).map(innerCopy),
	};

	const compound: CompoundElement = {
		id: generateUUID(),
		type: "compound",
		name,
		sceneId,
		startTime: start,
		duration,
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		sourceDuration: duration,
		params: {},
	};

	// Tracks emptied by moving the clips out go away; others stay as they were.
	const keepTrack = ({ track, emptied }: { track: TimelineTrack; emptied: TimelineTrack }) =>
		emptied.elements.length > 0 || !hadSelection(track);
	const overlay = tracks.overlay
		.map((track) => ({ track, emptied: without(track) }))
		.filter(({ track, emptied }) => keepTrack({ track, emptied }));
	const audio: AudioTrack[] = tracks.audio
		.map((track) => without(track))
		.filter((emptied, index) => keepTrack({ track: tracks.audio[index], emptied }));
	let main: VideoTrack = without(tracks.main);

	// The compound clip goes on the topmost video track the clips came from,
	// if the span is free there; otherwise on a new video track at that layer.
	const fits = (track: VideoTrack) =>
		track.elements.every((element) => {
			const elementEnd = addMediaTime({ a: element.startTime, b: element.duration });
			return elementEnd <= start || element.startTime >= end;
		});
	const topSource = tracks.overlay.findIndex(
		(track) => track.type === "video" && hadSelection(track),
	);
	let compoundTrackId: string;
	const overlayTracks: OverlayTrack[] = overlay.map(({ emptied }) => emptied);

	const hostIndex =
		topSource >= 0
			? overlay.findIndex(({ track }) => track.id === tracks.overlay[topSource].id)
			: -1;
	const host = hostIndex >= 0 ? overlayTracks[hostIndex] : null;
	if (host && host.type === "video" && fits(host)) {
		overlayTracks[hostIndex] = { ...host, elements: insertSorted({ elements: host.elements, element: compound }) };
		compoundTrackId = host.id;
	} else if (topSource < 0 && hadSelection(tracks.main) && fits(main)) {
		main = { ...main, elements: insertSorted({ elements: main.elements, element: compound }) };
		compoundTrackId = main.id;
	} else {
		const newTrack: VideoTrack = {
			id: generateUUID(),
			name: name,
			type: "video",
			elements: [compound],
			muted: false,
			hidden: false,
		};
		// Above the layer the topmost clip came from (or just above the main
		// track when they all came from it or from audio).
		const firstSelectedOverlay = tracks.overlay.findIndex(hadSelection);
		const originalIndex = (track: OverlayTrack) =>
			tracks.overlay.findIndex((original) => original.id === track.id);
		const below =
			firstSelectedOverlay < 0
				? -1
				: overlayTracks.findIndex((track) => originalIndex(track) >= firstSelectedOverlay);
		overlayTracks.splice(below < 0 ? overlayTracks.length : below, 0, newTrack);
		compoundTrackId = newTrack.id;
	}

	return {
		innerTracks,
		outerTracks: { overlay: overlayTracks, main, audio },
		compound,
		compoundTrackId,
	};
}

function insertSorted<T extends { startTime: MediaTime }>({
	elements,
	element,
}: {
	elements: readonly T[];
	element: T;
}): T[] {
	return [...elements, element].sort((a, b) => a.startTime - b.startTime);
}
