"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useEditor } from "@/editor/use-editor";
import { drawTransitionPreview } from "@/services/renderer/transition-preview";
import {
	buildTransition,
	findDefaultTransitionTarget,
	getTransitionDefinitions,
	type TransitionDefinition,
} from "@/transitions";

const PREVIEW_WIDTH = 192;
const PREVIEW_HEIGHT = 108;
/** Frame shown while the card is not hovered. */
const RESTING_PROGRESS = 0.4;
const PREVIEW_TRANSITION_MS = 1100;
const PREVIEW_HOLD_MS = 500;

export function TransitionsView() {
	const transitions = getTransitionDefinitions();

	return (
		<PanelView title="Transitions">
			<p className="text-muted-foreground mb-3 text-xs">
				Drag a transition onto the cut between two clips, or select a clip
				and press + to add one at its start.
			</p>
			<div
				className="grid gap-2"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
			>
				{transitions.map((transition) => (
					<TransitionItem key={transition.type} transition={transition} />
				))}
			</div>
		</PanelView>
	);
}

function TransitionPreviewCanvas({ type }: { type: string }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const frameRef = useRef<number | null>(null);

	const draw = useCallback(
		(progress: number) => {
			const ctx = canvasRef.current?.getContext("2d");
			if (!ctx) {
				return;
			}
			drawTransitionPreview({
				ctx,
				type,
				progress,
				width: PREVIEW_WIDTH,
				height: PREVIEW_HEIGHT,
			});
		},
		[type],
	);

	const stop = useCallback(() => {
		if (frameRef.current !== null) {
			cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		}
		draw(RESTING_PROGRESS);
	}, [draw]);

	const play = useCallback(() => {
		if (frameRef.current !== null) {
			return;
		}
		const startedAt = performance.now();
		const tick = (now: number) => {
			const cycle = PREVIEW_TRANSITION_MS + PREVIEW_HOLD_MS;
			const elapsed = (now - startedAt) % cycle;
			draw(Math.min(1, elapsed / PREVIEW_TRANSITION_MS));
			frameRef.current = requestAnimationFrame(tick);
		};
		frameRef.current = requestAnimationFrame(tick);
	}, [draw]);

	useEffect(() => {
		draw(RESTING_PROGRESS);
		return () => {
			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current);
			}
		};
	}, [draw]);

	return (
		<canvas
			ref={canvasRef}
			width={PREVIEW_WIDTH}
			height={PREVIEW_HEIGHT}
			className="size-full"
			onMouseEnter={play}
			onMouseLeave={stop}
		/>
	);
}

function TransitionItem({ transition }: { transition: TransitionDefinition }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const sceneTracks = editor.scenes.getActiveScene().tracks;
		const target = findDefaultTransitionTarget({
			tracks: [...sceneTracks.overlay, sceneTracks.main],
			selectedElements: editor.selection.getSelectedElements(),
			playheadTime: editor.playback.getCurrentTime(),
		});
		if (!target) {
			toast.error("No cut to add a transition to", {
				description:
					"Place two video or image clips next to each other on the same track.",
			});
			return;
		}

		const built = buildTransition({ type: transition.type });
		const existing = target.cut.to.transitionIn;
		editor.timeline.setElementTransition({
			trackId: target.trackId,
			elementId: target.cut.to.id,
			transition: existing ? { ...built, duration: existing.duration } : built,
		});
	}, [editor, transition.type]);

	return (
		<DraggableItem
			name={transition.name}
			preview={<TransitionPreviewCanvas type={transition.type} />}
			dragData={{
				id: transition.type,
				name: transition.name,
				type: "transition",
				transitionType: transition.type,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={16 / 9}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
