import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import type { MediaAsset } from "@/media/types";
import {
	getVisibleElementsWithBounds,
	type ElementWithBounds,
} from "@/preview/element-bounds";
import {
	getHitElements,
	hitTest,
	resolvePreferredHit,
} from "@/preview/hit-test";
import {
	SNAP_THRESHOLD_SCREEN_PIXELS,
	snapPosition,
	type SnapLine,
} from "@/preview/preview-snap";
import type { TCanvasSize } from "@/project/types";
import { buildTransformFromParams, type Transform } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { getElementLocalTime } from "@/animation";
import { buildTransformWrite } from "@/preview/transform-write";
import { isVisualElement } from "@/timeline/element-utils";
import type {
	ElementRef,
	SceneTracks,
	TextElement,
	TimelineElement,
	TimelineTrack,
	VisualElement,
} from "@/timeline";

const MIN_DRAG_DISTANCE = 0.5;
const PRIMARY_POINTER_BUTTON = 0;

type Point = { readonly x: number; readonly y: number };

interface CapturedPointerState {
	readonly pointerId: number;
	readonly captureTarget: HTMLElement;
}

interface PendingGesture extends CapturedPointerState {
	readonly kind: "pending";
	readonly origin: Point;
	readonly topmostHit: ElementWithBounds | null;
	readonly selectedHit: ElementWithBounds | null;
	readonly selectedElements: readonly ElementRef[];
	/** Shift/Ctrl/Cmd held: the click adds to or removes from the selection. */
	readonly isMultiKey: boolean;
	/** The pressed element was added to the selection by this press. */
	readonly addedOnPress: boolean;
}

interface DragElementSnapshot {
	readonly trackId: string;
	readonly elementId: string;
	readonly element: VisualElement;
	/** Ticks into the element at the playhead. */
	readonly localTime: number;
	/** The transform as displayed at the playhead (keyframes applied). */
	readonly initialTransform: Transform;
}

interface DraggingGesture extends CapturedPointerState {
	readonly kind: "dragging";
	readonly origin: Point;
	readonly bounds: {
		readonly width: number;
		readonly height: number;
		readonly rotation: number;
	};
	readonly elements: readonly DragElementSnapshot[];
}

type GestureSession =
	| { readonly kind: "idle" }
	| PendingGesture
	| DraggingGesture;

const IDLE_GESTURE: GestureSession = { kind: "idle" };

export interface EditingTextState {
	readonly trackId: string;
	readonly elementId: string;
	readonly element: TextElement;
}

export interface PreviewViewportAdapter {
	screenToCanvas: ({
		clientX,
		clientY,
	}: {
		clientX: number;
		clientY: number;
	}) => Point | null;
	screenPixelsToLogicalThreshold: ({
		screenPixels,
	}: {
		screenPixels: number;
	}) => Point;
}

export interface InputAdapter {
	isShiftHeld: () => boolean;
}

export interface SceneReader {
	getTracks: () => SceneTracks;
	getCurrentTime: () => number;
	getMediaAssets: () => MediaAsset[];
	getCanvasSize: () => TCanvasSize;
}

export interface SelectionApi {
	getSelected: () => readonly ElementRef[];
	setSelected: (elements: readonly ElementRef[]) => void;
	clearSelection: () => void;
}

export interface TimelinePreviewUpdate {
	readonly trackId: string;
	readonly elementId: string;
	readonly updates: Partial<TimelineElement>;
}

export interface TimelineOps {
	getElementsWithTracks: ({
		elements,
	}: {
		elements: readonly ElementRef[];
	}) => Array<{ track: TimelineTrack; element: TimelineElement }>;
	previewElements: (updates: readonly TimelinePreviewUpdate[]) => void;
	commitPreview: () => void;
	discardPreview: () => void;
}

export interface PlaybackApi {
	getIsPlaying: () => boolean;
	subscribe: (listener: () => void) => () => void;
}

export interface PreviewOptions {
	isMaskMode: () => boolean;
	onSnapLinesChange?: (lines: SnapLine[]) => void;
}

export interface PreviewInteractionDeps {
	viewport: PreviewViewportAdapter;
	input: InputAdapter;
	scene: SceneReader;
	selection: SelectionApi;
	timeline: TimelineOps;
	playback: PlaybackApi;
	preview: PreviewOptions;
}

export interface PreviewInteractionDepsRef {
	readonly current: PreviewInteractionDeps;
}

function isSameElementRef({
	left,
	right,
}: {
	left: ElementRef;
	right: ElementRef;
}): boolean {
	return left.trackId === right.trackId && left.elementId === right.elementId;
}

function buildDragSelection({
	selectedElements,
	dragTarget,
}: {
	selectedElements: readonly ElementRef[];
	dragTarget: ElementWithBounds;
}): ElementRef[] {
	const dragTargetRef = {
		trackId: dragTarget.trackId,
		elementId: dragTarget.elementId,
	};

	if (
		!selectedElements.some((selectedElement) =>
			isSameElementRef({ left: selectedElement, right: dragTargetRef }),
		)
	) {
		return [dragTargetRef];
	}

	return [
		dragTargetRef,
		...selectedElements.filter(
			(selectedElement) =>
				!isSameElementRef({ left: selectedElement, right: dragTargetRef }),
		),
	];
}

function movedPastDragThreshold({
	current,
	origin,
}: {
	current: Point;
	origin: Point;
}): boolean {
	return (
		Math.abs(current.x - origin.x) > MIN_DRAG_DISTANCE ||
		Math.abs(current.y - origin.y) > MIN_DRAG_DISTANCE
	);
}

function toDragElementSnapshots({
	elementsWithTracks,
	currentTime,
}: {
	elementsWithTracks: Array<{ track: TimelineTrack; element: TimelineElement }>;
	currentTime: number;
}): DragElementSnapshot[] {
	const isVisualTrackedElement = (value: {
		track: TimelineTrack;
		element: TimelineElement;
	}): value is { track: TimelineTrack; element: VisualElement } =>
		isVisualElement(value.element);

	return elementsWithTracks
		.filter(isVisualTrackedElement)
		.map(({ track, element }) => {
			const localTime = getElementLocalTime({
				timelineTime: currentTime,
				elementStartTime: element.startTime,
				elementDuration: element.duration,
			});
			return {
				trackId: track.id,
				elementId: element.id,
				element,
				localTime,
				initialTransform: resolveTransformAtTime({
					baseTransform: buildTransformFromParams({ params: element.params }),
					animations: element.animations,
					localTime,
				}),
			};
		});
}

export class PreviewInteractionController {
	private readonly depsRef: PreviewInteractionDepsRef;
	private readonly subscribers = new Set<() => void>();

	private gesture: GestureSession = IDLE_GESTURE;
	private editingTextState: EditingTextState | null = null;
	private wasPlaying: boolean;
	private unsubscribePlayback: (() => void) | null = null;

	constructor({ depsRef }: { depsRef: PreviewInteractionDepsRef }) {
		this.depsRef = depsRef;
		this.wasPlaying = this.deps.playback.getIsPlaying();

		this.onDoubleClick = this.onDoubleClick.bind(this);
		this.onPointerDown = this.onPointerDown.bind(this);
		this.onPointerMove = this.onPointerMove.bind(this);
		this.onPointerUp = this.onPointerUp.bind(this);
		this.commitTextEdit = this.commitTextEdit.bind(this);
		this.handlePlaybackChange = this.handlePlaybackChange.bind(this);

		this.unsubscribePlayback = this.deps.playback.subscribe(
			this.handlePlaybackChange,
		);
	}

	private get deps(): PreviewInteractionDeps {
		return this.depsRef.current;
	}

	get isDragging(): boolean {
		return this.gesture.kind === "dragging";
	}

	get editingText(): EditingTextState | null {
		return this.editingTextState;
	}

	subscribe({ listener }: { listener: () => void }): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	destroy(): void {
		this.unsubscribePlayback?.();
		this.unsubscribePlayback = null;
		this.abortActiveGesture();
		this.editingTextState = null;
		this.subscribers.clear();
	}

	cancel(): void {
		if (this.gesture.kind === "idle") return;
		this.abortActiveGesture();
		this.notify();
	}

	private abortActiveGesture(): void {
		if (this.gesture.kind === "idle") return;

		if (this.gesture.kind === "dragging") {
			this.deps.timeline.discardPreview();
		}

		this.releaseCapturedPointer({ pointerState: this.gesture });
		this.gesture = IDLE_GESTURE;
		this.clearSnapLines();
	}

	commitTextEdit(): void {
		if (!this.editingTextState) return;

		this.editingTextState = null;
		this.deps.timeline.commitPreview();
		this.notify();
	}

	onDoubleClick({ clientX, clientY }: ReactMouseEvent): void {
		// Double-clicks inside the text box go to the box itself; one that
		// reaches the viewer is outside it, so finish that edit first.
		this.commitTextEdit();
		if (this.deps.preview.isMaskMode()) return;

		const startPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!startPos) return;

		const hit = hitTest({
			canvasX: startPos.x,
			canvasY: startPos.y,
			elementsWithBounds: this.getVisibleElementsWithBounds(),
		});

		if (!hit || hit.element.type !== "text") return;

		this.editingTextState = {
			trackId: hit.trackId,
			elementId: hit.elementId,
			element: hit.element,
		};
		this.notify();
	}

	onPointerDown({
		clientX,
		clientY,
		currentTarget,
		pointerId,
		button,
		shiftKey,
		ctrlKey,
		metaKey,
	}: ReactPointerEvent): void {
		// A press that reaches the viewer is outside the text box: finish the
		// edit and handle the press, instead of ignoring every click until
		// something else ends the edit (the box is invisible, so a stuck edit
		// looked like the viewer had frozen).
		this.commitTextEdit();
		if (this.deps.preview.isMaskMode()) return;
		if (button !== PRIMARY_POINTER_BUTTON) return;

		const startPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!startPos) return;

		const hits = getHitElements({
			canvasX: startPos.x,
			canvasY: startPos.y,
			elementsWithBounds: this.getVisibleElementsWithBounds(),
		});
		const isMultiKey = shiftKey || ctrlKey || metaKey;
		const topmostHit = hits[0] ?? null;
		let selectedElements = this.deps.selection.getSelected();
		let addedOnPress = false;
		// Shift/Ctrl/Cmd-pressing an unselected element adds it right away, so
		// dragging moves it together with everything already selected.
		if (
			isMultiKey &&
			topmostHit &&
			!selectedElements.some((ref) => isSameElementRef({ left: ref, right: topmostHit }))
		) {
			selectedElements = [
				...selectedElements,
				{ trackId: topmostHit.trackId, elementId: topmostHit.elementId },
			];
			this.deps.selection.setSelected(selectedElements);
			addedOnPress = true;
		}

		this.gesture = {
			kind: "pending",
			origin: startPos,
			pointerId,
			captureTarget: currentTarget as HTMLElement,
			topmostHit,
			selectedHit: resolvePreferredHit({
				hits,
				preferredElements: [...selectedElements],
			}),
			selectedElements,
			isMultiKey,
			addedOnPress,
		};

		currentTarget.setPointerCapture(pointerId);
	}

	onPointerMove({ clientX, clientY }: ReactPointerEvent): void {
		const currentPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!currentPos) return;

		if (this.gesture.kind === "pending") {
			const pending = this.gesture;
			if (
				!movedPastDragThreshold({
					current: currentPos,
					origin: pending.origin,
				})
			) {
				this.clearSnapLines();
				return;
			}

			this.beginDragFromPending({ pending });
		}

		if (this.gesture.kind !== "dragging") return;

		this.updateDragPreview({
			drag: this.gesture,
			currentPos,
		});
	}

	onPointerUp({ type }: ReactPointerEvent): void {
		if (this.gesture.kind === "dragging") {
			const drag = this.gesture;

			if (type === "pointercancel") {
				this.deps.timeline.discardPreview();
			} else {
				this.deps.timeline.commitPreview();
			}

			this.gesture = IDLE_GESTURE;
			this.clearSnapLines();
			this.releaseCapturedPointer({ pointerState: drag });
			this.notify();
			return;
		}

		if (this.gesture.kind !== "pending") return;

		const pending = this.gesture;

		if (type !== "pointercancel" && pending.isMultiKey) {
			// A modifier click toggles the element; clicking empty space with a
			// modifier keeps the selection.
			const clickTarget = pending.topmostHit;
			if (clickTarget && !pending.addedOnPress) {
				this.deps.selection.setSelected(
					pending.selectedElements.filter(
						(ref) => !isSameElementRef({ left: ref, right: clickTarget }),
					),
				);
			}
		} else if (type !== "pointercancel") {
			const clickTarget = pending.topmostHit;
			if (!clickTarget) {
				this.deps.selection.clearSelection();
			} else {
				this.deps.selection.setSelected([
					{
						trackId: clickTarget.trackId,
						elementId: clickTarget.elementId,
					},
				]);
			}
		}

		this.gesture = IDLE_GESTURE;
		this.clearSnapLines();
		this.releaseCapturedPointer({ pointerState: pending });
	}

	private notify(): void {
		for (const listener of this.subscribers) listener();
	}

	private clearSnapLines(): void {
		this.deps.preview.onSnapLinesChange?.([]);
	}

	private releaseCapturedPointer({
		pointerState,
	}: {
		pointerState: CapturedPointerState | null;
	}): void {
		if (!pointerState) return;

		if (!pointerState.captureTarget.hasPointerCapture(pointerState.pointerId)) {
			return;
		}

		pointerState.captureTarget.releasePointerCapture(pointerState.pointerId);
	}

	private getVisibleElementsWithBounds(): ElementWithBounds[] {
		return getVisibleElementsWithBounds({
			tracks: this.deps.scene.getTracks(),
			currentTime: this.deps.scene.getCurrentTime(),
			canvasSize: this.deps.scene.getCanvasSize(),
			mediaAssets: this.deps.scene.getMediaAssets(),
		});
	}

	private handlePlaybackChange(): void {
		const isPlaying = this.deps.playback.getIsPlaying();
		if (isPlaying && !this.wasPlaying && this.editingTextState) {
			this.commitTextEdit();
		}
		this.wasPlaying = isPlaying;

		// Seeking off the text clip hides it; don't keep editing it unseen.
		const editing = this.editingTextState;
		if (editing) {
			const time = this.deps.scene.getCurrentTime();
			const { startTime, duration } = editing.element;
			if (time < startTime || time >= startTime + duration) {
				this.commitTextEdit();
			}
		}
	}

	private beginDragFromPending({ pending }: { pending: PendingGesture }): void {
		const dragTarget = pending.selectedHit ?? pending.topmostHit;
		if (!dragTarget) {
			this.gesture = IDLE_GESTURE;
			this.clearSnapLines();
			this.releaseCapturedPointer({ pointerState: pending });
			return;
		}

		const dragSelection = buildDragSelection({
			selectedElements: pending.selectedElements,
			dragTarget,
		});
		const draggableElements = toDragElementSnapshots({
			elementsWithTracks: this.deps.timeline.getElementsWithTracks({
				elements: dragSelection,
			}),
			currentTime: this.deps.scene.getCurrentTime(),
		});

		if (draggableElements.length === 0) {
			this.gesture = IDLE_GESTURE;
			this.clearSnapLines();
			this.releaseCapturedPointer({ pointerState: pending });
			return;
		}

		if (pending.selectedHit === null) {
			this.deps.selection.setSelected([
				{
					trackId: dragTarget.trackId,
					elementId: dragTarget.elementId,
				},
			]);
		}

		this.gesture = {
			kind: "dragging",
			origin: pending.origin,
			pointerId: pending.pointerId,
			captureTarget: pending.captureTarget,
			bounds: {
				width: dragTarget.bounds.width,
				height: dragTarget.bounds.height,
				rotation: dragTarget.bounds.rotation,
			},
			elements: draggableElements,
		};
		this.notify();
	}

	private updateDragPreview({
		drag,
		currentPos,
	}: {
		drag: DraggingGesture;
		currentPos: Point;
	}): void {
		const firstElement = drag.elements[0];
		if (!firstElement) return;

		const deltaX = currentPos.x - drag.origin.x;
		const deltaY = currentPos.y - drag.origin.y;

		const proposedPosition = {
			x: firstElement.initialTransform.position.x + deltaX,
			y: firstElement.initialTransform.position.y + deltaY,
		};

		const shouldSnap = !this.deps.input.isShiftHeld();
		const snapThreshold = this.deps.viewport.screenPixelsToLogicalThreshold({
			screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
		});
		const { snappedPosition, activeLines } = shouldSnap
			? snapPosition({
					proposedPosition,
					canvasSize: this.deps.scene.getCanvasSize(),
					elementSize: drag.bounds,
					rotation: drag.bounds.rotation,
					snapThreshold,
				})
			: {
					snappedPosition: proposedPosition,
					activeLines: [] as SnapLine[],
				};

		this.deps.preview.onSnapLinesChange?.(activeLines);

		const deltaSnappedX =
			snappedPosition.x - firstElement.initialTransform.position.x;
		const deltaSnappedY =
			snappedPosition.y - firstElement.initialTransform.position.y;

		this.deps.timeline.previewElements(
			drag.elements.map(({ trackId, elementId, element, localTime, initialTransform }) => ({
				trackId,
				elementId,
				updates: buildTransformWrite({
					element,
					localTime,
					transform: {
						...initialTransform,
						position: {
							x: initialTransform.position.x + deltaSnappedX,
							y: initialTransform.position.y + deltaSnappedY,
						},
					},
				}),
			})),
		);
	}
}
