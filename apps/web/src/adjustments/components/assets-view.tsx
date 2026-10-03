"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { isAdjustableElementType } from "@/adjustments";
import { AdjustmentControls } from "./adjustment-controls";

/** Color and blur adjustments for whatever is selected on the timeline. */
export function AdjustmentView() {
	const editor = useEditor();
	useEditor((e) => e.scenes.getActiveSceneOrNull());
	const { selectedElements } = useElementSelection();

	const selected =
		selectedElements.length === 1
			? editor.timeline.getElementsWithTracks({ elements: selectedElements })[0]
			: undefined;

	if (!selected) {
		return (
			<PanelView title="Adjustment">
				<AdjustmentMessage
					title={selectedElements.length > 1 ? "Select one element" : "Nothing selected"}
					description={
						selectedElements.length > 1
							? "Adjustments apply to one element at a time."
							: "Click a video, image, text or sticker on the timeline to adjust its colors."
					}
				/>
			</PanelView>
		);
	}

	const { element, track } = selected;
	if (!isAdjustableElementType(element.type)) {
		return (
			<PanelView title="Adjustment">
				<AdjustmentMessage
					title="Can't adjust this element"
					description="Adjustments work on video, image, text, sticker and shape elements."
				/>
			</PanelView>
		);
	}

	return (
		<PanelView title={`Adjust · ${element.name}`} contentClassName="p-0">
			<AdjustmentControls element={element} trackId={track.id} />
		</PanelView>
	);
}

function AdjustmentMessage({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-4 py-16 text-center">
			<HugeiconsIcon
				icon={SlidersHorizontalIcon}
				className="text-muted-foreground/75 size-10"
				strokeWidth={1}
			/>
			<p className="font-medium">{title}</p>
			<p className="text-muted-foreground max-w-56 text-sm text-balance">
				{description}
			</p>
		</div>
	);
}
