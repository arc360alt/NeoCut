"use client";

import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { TimelineElement } from "./timeline-element";
import type { TimelineTrack } from "@/timeline";
import type { TimelineElement as TimelineElementType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import { TimelineTransitions } from "@/transitions/components/timeline-transitions";
import type { ElementDragView } from "@/timeline";
import type { VisibleTimeRange } from "@/timeline/hooks/use-visible-time-range";
import { useCallback, useMemo } from "react";
import { useEditor } from "@/editor/use-editor";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";

/** Clips narrower than this on screen are drawn as plain strips. */
const MIN_FULL_ELEMENT_WIDTH_PX = 4;

interface CompactRun {
	start: number;
	end: number;
	elements: TimelineElementType[];
}

interface TimelineTrackContentProps {
	track: TimelineTrack;
	zoomLevel: number;
	dragView: ElementDragView;
	onResizeStart: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onElementMouseDown: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onElementClick: (params: {
		event: React.MouseEvent;
		element: TimelineElementType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetElementId?: string | null;
	/** Only clips overlapping this span are mounted; null renders all. */
	visibleRange?: VisibleTimeRange | null;
}

export function TimelineTrackContent({
	track,
	zoomLevel,
	dragView,
	onResizeStart,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetElementId = null,
	visibleRange = null,
}: TimelineTrackContentProps) {
	const { isElementSelected } = useElementSelection();

	// Long edits can have thousands of clips; mounting only the ones near the
	// viewport keeps selection, zoom and scroll fast. Selected and dragged
	// clips stay mounted so their interactions keep working.
	// One handler per track shared by every clip, so memoized clips are not
	// re-rendered just because their callbacks were recreated.
	const handleResizeStart = useCallback(
		({
			event,
			element,
			side,
		}: {
			event: React.MouseEvent;
			element: TimelineElementType;
			side: "left" | "right";
		}) => onResizeStart({ event, element, track, side }),
		[onResizeStart, track],
	);
	const handleElementMouseDown = useCallback(
		({ event, element }: { event: React.MouseEvent; element: TimelineElementType }) =>
			onElementMouseDown({ event, element, track }),
		[onElementMouseDown, track],
	);
	const handleElementClick = useCallback(
		({ event, element }: { event: React.MouseEvent; element: TimelineElementType }) =>
			onElementClick({ event, element, track }),
		[onElementClick, track],
	);

	// Zoomed far out, clips can be under a pixel wide; those are merged into
	// strips instead of mounting a full clip component for each.
	const { renderedElements, compactRuns } = useMemo(() => {
		const dragged =
			dragView.kind === "dragging" ? dragView.memberTimeOffsets : null;
		const full: TimelineElementType[] = [];
		const compact: TimelineElementType[] = [];
		for (const element of track.elements) {
			const isPinned =
				dragged?.has(element.id) ||
				isElementSelected({ trackId: track.id, elementId: element.id });
			const isVisible =
				!visibleRange ||
				(element.startTime < visibleRange.end &&
					element.startTime + element.duration > visibleRange.start);
			if (!isPinned && !isVisible) continue;
			const width = timelineTimeToPixels({ time: element.duration, zoomLevel });
			if (!isPinned && width < MIN_FULL_ELEMENT_WIDTH_PX) {
				compact.push(element);
			} else {
				full.push(element);
			}
		}
		return {
			renderedElements: full,
			compactRuns: buildCompactRuns({ elements: compact, zoomLevel }),
		};
	}, [track, visibleRange, dragView, isElementSelected, zoomLevel]);

	return (
		<div className="relative size-full">
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={`Select ${track.name} track`}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{track.elements.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					renderedElements.map((element) => {
						const isSelected = isElementSelected({
							trackId: track.id,
							elementId: element.id,
						});

						return (
							<TimelineElement
								key={element.id}
								element={element}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								onResizeStart={handleResizeStart}
								onElementMouseDown={handleElementMouseDown}
								onElementClick={handleElementClick}
								dragView={dragView}
								isDropTarget={element.id === targetElementId}
							/>
						);
					})
				)}
				{compactRuns.map((run) => (
					<CompactClipRun
						key={`${run.start}:${run.elements[0]?.id}`}
						run={run}
						trackId={track.id}
						zoomLevel={zoomLevel}
					/>
				))}
				<TimelineTransitions track={track} zoomLevel={zoomLevel} />
			</div>
		</div>
	);
}

function buildCompactRuns({
	elements,
	zoomLevel,
}: {
	elements: TimelineElementType[];
	zoomLevel: number;
}): CompactRun[] {
	const sorted = elements.slice().sort((a, b) => a.startTime - b.startTime);
	const runs: CompactRun[] = [];
	for (const element of sorted) {
		const end = element.startTime + element.duration;
		const last = runs[runs.length - 1];
		const gapPx = last
			? timelineTimeToPixels({ time: element.startTime - last.end, zoomLevel })
			: Number.POSITIVE_INFINITY;
		if (last && gapPx < 1) {
			last.end = Math.max(last.end, end);
			last.elements.push(element);
		} else {
			runs.push({ start: element.startTime, end, elements: [element] });
		}
	}
	return runs;
}

/** Many clips too small to show individually; clicking selects the one under the cursor. */
function CompactClipRun({
	run,
	trackId,
	zoomLevel,
}: {
	run: CompactRun;
	trackId: string;
	zoomLevel: number;
}) {
	const editor = useEditor();
	const left = timelineTimeToPixels({ time: run.start, zoomLevel });
	const width = Math.max(
		1,
		timelineTimeToPixels({ time: run.end - run.start, zoomLevel }),
	);

	return (
		<button
			type="button"
			aria-label={`${run.elements.length} clips, zoom in to edit them`}
			title={`${run.elements.length} clips — zoom in to edit`}
			className="bg-primary/50 hover:bg-primary/70 absolute inset-y-1 rounded-[2px] p-0"
			style={{ left: `${left}px`, width: `${width}px` }}
			onMouseDown={(event) => event.stopPropagation()}
			onClick={(event) => {
				event.stopPropagation();
				const rect = event.currentTarget.getBoundingClientRect();
				const fraction = Math.min(
					1,
					Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)),
				);
				const time = run.start + fraction * (run.end - run.start);
				const element =
					run.elements.find(
						(candidate) =>
							candidate.startTime <= time &&
							time < candidate.startTime + candidate.duration,
					) ?? run.elements[0];
				editor.selection.setSelectedElements({
					elements: [{ trackId, elementId: element.id }],
				});
			}}
		/>
	);
}
