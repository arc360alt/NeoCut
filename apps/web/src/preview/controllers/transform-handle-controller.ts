import type { PointerEvent as ReactPointerEvent } from "react";
import type { MediaAsset } from "@/media/types";
import {
	getVisibleElementsWithBounds,
	type Corner,
	type Edge,
	type ElementBounds,
	type ElementWithBounds,
} from "@/preview/element-bounds";
import { MIN_SCALE, snapRotation, type SnapLine } from "@/preview/preview-snap";
import { buildTransformWrite } from "@/preview/transform-write";
import { isVisualElement } from "@/timeline/element-utils";
import { getElementLocalTime } from "@/animation";
import { buildTransformFromParams, type Transform } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	VisualElement,
} from "@/timeline";

type Point = { readonly x: number; readonly y: number };
type CanvasSize = { readonly width: number; readonly height: number };
type HandleType = Corner | Edge | "rotation";

interface CapturedPointerState {
	readonly pointerId: number;
	readonly captureTarget: HTMLElement;
}

/**
 * Dragging a corner or side handle. The dragged side follows the pointer and
 * the opposite side stays put; with Shift the element keeps its proportions.
 * All geometry is in the element's own (rotated) frame.
 */
interface ResizeSession extends CapturedPointerState {
	readonly kind: "resize";
	readonly handle: Corner | Edge;
	/** Which way the handle points: -1, 0 or 1 on each axis. */
	readonly directionX: number;
	readonly directionY: number;
	readonly trackId: string;
	readonly elementId: string;
	readonly element: VisualElement;
	readonly localTime: number;
	readonly initialTransform: Transform;
	readonly centerX: number;
	readonly centerY: number;
	readonly rotationRad: number;
	/** Half the displayed size, in canvas pixels. */
	readonly halfWidth: number;
	readonly halfHeight: number;
	/** Size at scale 1, so a new size converts back to a scale. */
	readonly baseWidth: number;
	readonly baseHeight: number;
}

interface RotationSession extends CapturedPointerState {
	readonly kind: "rotation";
	readonly trackId: string;
	readonly elementId: string;
	readonly element: VisualElement;
	readonly localTime: number;
	readonly initialTransform: Transform;
	readonly initialAngle: number;
	readonly initialBoundsCx: number;
	readonly initialBoundsCy: number;
}

type TransformSession =
	| { readonly kind: "idle" }
	| ResizeSession
	| RotationSession;

const IDLE_SESSION: TransformSession = { kind: "idle" };

interface VisualSelectionContext {
	readonly trackId: string;
	readonly elementId: string;
	readonly element: VisualElement;
	readonly bounds: ElementBounds;
	readonly resolvedTransform: Transform;
	readonly localTime: number;
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
	getSelectedElements: () => readonly ElementRef[];
	getTracks: () => SceneTracks;
	getCurrentTime: () => number;
	getMediaAssets: () => MediaAsset[];
	getCanvasSize: () => CanvasSize;
}

export interface TimelinePreviewUpdate {
	readonly trackId: string;
	readonly elementId: string;
	readonly updates: Partial<TimelineElement>;
}

export interface TimelineOps {
	previewElements: (updates: readonly TimelinePreviewUpdate[]) => void;
	commitPreview: () => void;
	discardPreview: () => void;
}

export interface PreviewOptions {
	onSnapLinesChange?: (lines: SnapLine[]) => void;
}

export interface TransformHandleDeps {
	viewport: PreviewViewportAdapter;
	input: InputAdapter;
	scene: SceneReader;
	timeline: TimelineOps;
	preview: PreviewOptions;
}

export interface TransformHandleDepsRef {
	readonly current: TransformHandleDeps;
}

function clampScaleNonZero(scale: number): number {
	if (Math.abs(scale) < MIN_SCALE) {
		return scale < 0 ? -MIN_SCALE : MIN_SCALE;
	}
	return scale;
}

/** Smallest displayed size a resize can reach, in canvas pixels. */
const MIN_RESIZE_SIZE = 1;

function getHandleDirection({ handle }: { handle: Corner | Edge }): {
	directionX: number;
	directionY: number;
} {
	const directionX = handle.includes("left") ? -1 : handle.includes("right") ? 1 : 0;
	const directionY = handle.includes("top") ? -1 : handle.includes("bottom") ? 1 : 0;
	return { directionX, directionY };
}

function rotatePoint({ x, y, angleRad }: { x: number; y: number; angleRad: number }): Point {
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	return { x: x * cos - y * sin, y: x * sin + y * cos };
}

function buildSelectedWithBounds({
	selectedElements,
	elementsWithBounds,
}: {
	selectedElements: readonly ElementRef[];
	elementsWithBounds: readonly ElementWithBounds[];
}): ElementWithBounds | null {
	if (selectedElements.length !== 1) return null;

	return (
		elementsWithBounds.find(
			(entry) =>
				entry.trackId === selectedElements[0].trackId &&
				entry.elementId === selectedElements[0].elementId,
		) ?? null
	);
}

export class TransformHandleController {
	private readonly depsRef: TransformHandleDepsRef;
	private readonly subscribers = new Set<() => void>();

	private session: TransformSession = IDLE_SESSION;

	constructor({ depsRef }: { depsRef: TransformHandleDepsRef }) {
		this.depsRef = depsRef;

		this.onCornerPointerDown = this.onCornerPointerDown.bind(this);
		this.onEdgePointerDown = this.onEdgePointerDown.bind(this);
		this.onRotationPointerDown = this.onRotationPointerDown.bind(this);
		this.onPointerMove = this.onPointerMove.bind(this);
		this.onPointerUp = this.onPointerUp.bind(this);
	}

	private get deps(): TransformHandleDeps {
		return this.depsRef.current;
	}

	get selectedWithBounds(): ElementWithBounds | null {
		return buildSelectedWithBounds({
			selectedElements: this.deps.scene.getSelectedElements(),
			elementsWithBounds: this.getVisibleElementsWithBounds(),
		});
	}

	get activeHandle(): HandleType | null {
		switch (this.session.kind) {
			case "resize":
				return this.session.handle;
			case "rotation":
				return "rotation";
			default:
				return null;
		}
	}

	get isActive(): boolean {
		return this.session.kind !== "idle";
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	destroy(): void {
		if (this.session.kind !== "idle") {
			const session = this.session;
			this.session = IDLE_SESSION;
			this.deps.timeline.discardPreview();
			this.clearSnapLines();
			this.releaseCapturedPointer(session);
		}

		this.subscribers.clear();
	}

	cancel(): void {
		if (this.session.kind === "idle") return;

		const session = this.session;
		this.session = IDLE_SESSION;
		this.deps.timeline.discardPreview();
		this.clearSnapLines();
		this.releaseCapturedPointer(session);
		this.notify();
	}

	onCornerPointerDown({
		event,
		corner,
	}: {
		event: ReactPointerEvent;
		corner: Corner;
	}): void {
		this.beginResize({ event, handle: corner });
	}

	onEdgePointerDown({
		event,
		edge,
	}: {
		event: ReactPointerEvent;
		edge: Edge;
	}): void {
		this.beginResize({ event, handle: edge });
	}

	private beginResize({
		event,
		handle,
	}: {
		event: ReactPointerEvent;
		handle: Corner | Edge;
	}): void {
		const context = this.getSelectedVisualContext();
		if (!context) return;

		event.stopPropagation();

		const { scaleX, scaleY } = context.resolvedTransform;
		const halfWidth = context.bounds.width / 2;
		const halfHeight = context.bounds.height / 2;
		this.session = {
			kind: "resize",
			handle,
			...getHandleDirection({ handle }),
			trackId: context.trackId,
			elementId: context.elementId,
			element: context.element,
			localTime: context.localTime,
			initialTransform: context.resolvedTransform,
			centerX: context.bounds.cx,
			centerY: context.bounds.cy,
			rotationRad: (context.bounds.rotation * Math.PI) / 180,
			halfWidth,
			halfHeight,
			baseWidth: (halfWidth * 2) / Math.max(Math.abs(scaleX), MIN_SCALE),
			baseHeight: (halfHeight * 2) / Math.max(Math.abs(scaleY), MIN_SCALE),
			pointerId: event.pointerId,
			captureTarget: this.capturePointer({
				target: event.currentTarget as HTMLElement,
				pointerId: event.pointerId,
			}),
		};

		this.notify();
	}

	onRotationPointerDown({ event }: { event: ReactPointerEvent }): void {
		const context = this.getSelectedVisualContext();
		if (!context) return;

		event.stopPropagation();

		const position = this.deps.viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!position) return;

		const deltaX = position.x - context.bounds.cx;
		const deltaY = position.y - context.bounds.cy;
		const initialAngle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;

		this.session = {
			kind: "rotation",
			trackId: context.trackId,
			elementId: context.elementId,
			element: context.element,
			localTime: context.localTime,
			initialTransform: context.resolvedTransform,
			initialAngle,
			initialBoundsCx: context.bounds.cx,
			initialBoundsCy: context.bounds.cy,
			pointerId: event.pointerId,
			captureTarget: this.capturePointer({
				target: event.currentTarget as HTMLElement,
				pointerId: event.pointerId,
			}),
		};

		this.notify();
	}

	onPointerMove({ event }: { event: ReactPointerEvent }): void {
		if (this.session.kind === "idle") return;

		const position = this.deps.viewport.screenToCanvas({
			clientX: event.clientX,
			clientY: event.clientY,
		});
		if (!position) return;

		switch (this.session.kind) {
			case "resize":
				this.previewResize({
					session: this.session,
					position,
				});
				return;
			case "rotation":
				this.previewRotation({
					session: this.session,
					position,
				});
				return;
			default:
				return;
		}
	}

	onPointerUp(): void {
		if (this.session.kind === "idle") return;

		const session = this.session;
		this.session = IDLE_SESSION;
		this.deps.timeline.commitPreview();
		this.clearSnapLines();
		this.releaseCapturedPointer(session);
		this.notify();
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private clearSnapLines(): void {
		this.deps.preview.onSnapLinesChange?.([]);
	}

	private capturePointer({
		target,
		pointerId,
	}: {
		target: HTMLElement;
		pointerId: number;
	}): HTMLElement {
		target.setPointerCapture(pointerId);
		return target;
	}

	private releaseCapturedPointer(pointerState: CapturedPointerState): void {
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

	private getSelectedVisualContext(): VisualSelectionContext | null {
		const selectedWithBounds = this.selectedWithBounds;
		if (!selectedWithBounds) return null;
		if (!isVisualElement(selectedWithBounds.element)) return null;

		const localTime = getElementLocalTime({
			timelineTime: this.deps.scene.getCurrentTime(),
			elementStartTime: selectedWithBounds.element.startTime,
			elementDuration: selectedWithBounds.element.duration,
		});

		return {
			trackId: selectedWithBounds.trackId,
			elementId: selectedWithBounds.elementId,
			element: selectedWithBounds.element,
			bounds: selectedWithBounds.bounds,
			localTime,
			resolvedTransform: resolveTransformAtTime({
				baseTransform: buildTransformFromParams({
					params: selectedWithBounds.element.params,
				}),
				animations: selectedWithBounds.element.animations,
				localTime,
			}),
		};
	}

	private previewResize({
		session,
		position,
	}: {
		session: ResizeSession;
		position: Point;
	}): void {
		const { directionX, directionY, halfWidth, halfHeight } = session;
		// Pointer in the element's own frame (centre at 0, unrotated).
		const pointer = rotatePoint({
			x: position.x - session.centerX,
			y: position.y - session.centerY,
			angleRad: -session.rotationRad,
		});
		// The point that stays put: the opposite corner or side.
		const anchorX = -directionX * halfWidth;
		const anchorY = -directionY * halfHeight;

		let width =
			directionX === 0
				? halfWidth * 2
				: Math.max(MIN_RESIZE_SIZE, (pointer.x - anchorX) * directionX);
		let height =
			directionY === 0
				? halfHeight * 2
				: Math.max(MIN_RESIZE_SIZE, (pointer.y - anchorY) * directionY);

		if (this.deps.input.isShiftHeld()) {
			let factor: number;
			if (directionX !== 0 && directionY !== 0) {
				// Corner: follow the pointer along the diagonal.
				const diagonalX = directionX * halfWidth * 2;
				const diagonalY = directionY * halfHeight * 2;
				factor =
					((pointer.x - anchorX) * diagonalX + (pointer.y - anchorY) * diagonalY) /
					(diagonalX * diagonalX + diagonalY * diagonalY);
			} else {
				factor = directionX !== 0 ? width / (halfWidth * 2) : height / (halfHeight * 2);
			}
			factor = Math.max(MIN_RESIZE_SIZE / Math.max(halfWidth * 2, halfHeight * 2), factor);
			width = halfWidth * 2 * factor;
			height = halfHeight * 2 * factor;
		}

		// New centre: halfway between the anchor and the dragged side. A side
		// handle leaves the other axis centred.
		const localCenter = {
			x: directionX === 0 ? 0 : anchorX + (directionX * width) / 2,
			y: directionY === 0 ? 0 : anchorY + (directionY * height) / 2,
		};
		const centerOffset = rotatePoint({
			x: localCenter.x,
			y: localCenter.y,
			angleRad: session.rotationRad,
		});
		const initial = session.initialTransform;

		this.writeTransform({
			session,
			transform: {
				...initial,
				position: {
					x: initial.position.x + centerOffset.x,
					y: initial.position.y + centerOffset.y,
				},
				scaleX: clampScaleNonZero(
					(Math.sign(initial.scaleX) || 1) * (width / session.baseWidth),
				),
				scaleY: clampScaleNonZero(
					(Math.sign(initial.scaleY) || 1) * (height / session.baseHeight),
				),
			},
		});
	}

	private writeTransform({
		session,
		transform,
	}: {
		session: ResizeSession | RotationSession;
		transform: Transform;
	}): void {
		this.deps.timeline.previewElements([
			{
				trackId: session.trackId,
				elementId: session.elementId,
				updates: buildTransformWrite({
					element: session.element,
					transform,
					localTime: session.localTime,
				}),
			},
		]);
	}

	private previewRotation({
		session,
		position,
	}: {
		session: RotationSession;
		position: Point;
	}): void {
		const deltaX = position.x - session.initialBoundsCx;
		const deltaY = position.y - session.initialBoundsCy;
		const currentAngle = (Math.atan2(deltaY, deltaX) * 180) / Math.PI;
		let deltaAngle = currentAngle - session.initialAngle;
		if (deltaAngle > 180) deltaAngle -= 360;
		if (deltaAngle < -180) deltaAngle += 360;

		const newRotate = session.initialTransform.rotate + deltaAngle;
		const { snappedRotation } = this.deps.input.isShiftHeld()
			? { snappedRotation: newRotate }
			: snapRotation({ proposedRotation: newRotate });

		this.writeTransform({
			session,
			transform: { ...session.initialTransform, rotate: snappedRotation },
		});
	}
}
