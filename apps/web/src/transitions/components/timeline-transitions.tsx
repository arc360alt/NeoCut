"use client";

import { useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRightDoubleIcon } from "@hugeicons/core-free-icons";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { useEditor } from "@/editor/use-editor";
import type { TimelineTrack } from "@/timeline";
import { getTrackHeight } from "@/timeline/components/track-layout";
import { timelineTimeToSnappedPixels } from "@/timeline/pixel-utils";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { cn } from "@/utils/ui";
import {
	canTrackHaveTransitions,
	findTransitionDefinition,
	getTransitionWindows,
} from "@/transitions";

const MIN_BADGE_WIDTH_PX = 18;
const BADGE_HEIGHT_PX = 18;

/** Markers for the transitions on a track, centered on their cuts. */
export function TimelineTransitions({
	track,
	zoomLevel,
}: {
	track: TimelineTrack;
	zoomLevel: number;
}) {
	const editor = useEditor();
	const { isElementSelected } = useElementSelection();
	const setActiveTab = usePropertiesStore((state) => state.setActiveTab);

	const windows = useMemo(
		() =>
			canTrackHaveTransitions({ track })
				? getTransitionWindows({ elements: track.elements })
				: [],
		[track],
	);
	if (windows.length === 0) {
		return null;
	}

	const trackHeight = getTrackHeight({ type: track.type });

	return (
		<>
			{windows.map((window) => {
				const toElement = track.elements.find(
					(element) => element.id === window.toElementId,
				);
				if (!toElement) {
					return null;
				}

				const start = timelineTimeToSnappedPixels({
					time: window.start,
					zoomLevel,
				});
				const end = timelineTimeToSnappedPixels({
					time: window.end,
					zoomLevel,
				});
				const cut = timelineTimeToSnappedPixels({
					time: window.cutTime,
					zoomLevel,
				});
				const width = Math.max(MIN_BADGE_WIDTH_PX, end - start);
				const name =
					findTransitionDefinition({ type: window.transition.type })?.name ??
					"Transition";
				const isSelected = isElementSelected({
					trackId: track.id,
					elementId: toElement.id,
				});

				return (
					<button
						key={window.toElementId}
						type="button"
						title={`${name} transition`}
						aria-label={`${name} transition`}
						className={cn(
							"bg-background/85 text-foreground absolute z-1 flex items-center justify-center overflow-hidden rounded-sm border shadow-sm backdrop-blur-sm",
							"hover:border-primary cursor-pointer",
							isSelected ? "border-primary" : "border-foreground/40",
						)}
						style={{
							left: `${cut - width / 2}px`,
							top: `${trackHeight / 2 - BADGE_HEIGHT_PX / 2}px`,
							width: `${width}px`,
							height: `${BADGE_HEIGHT_PX}px`,
						}}
						onMouseDown={(event) => {
							event.stopPropagation();
							event.preventDefault();
						}}
						onClick={(event) => {
							event.stopPropagation();
							editor.selection.setSelectedElements({
								elements: [{ trackId: track.id, elementId: toElement.id }],
							});
							setActiveTab({ elementType: toElement.type, tabId: "transition" });
						}}
					>
						<HugeiconsIcon icon={ArrowRightDoubleIcon} size={12} />
					</button>
				);
			})}
		</>
	);
}
