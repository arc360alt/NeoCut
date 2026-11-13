import { useEffect, useRef } from "react";

interface UseEdgeAutoScrollParams {
	isActive: boolean;
	getMouseClientX: () => number;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	contentWidth: number;
	edgeThreshold?: number;
	maxScrollSpeed?: number;
	/** Called after each auto-scroll step, e.g. to keep a dragged item under the pointer. */
	onScroll?: () => void;
}

/** Pointer travel (px) toward an edge before that edge starts scrolling. */
const EDGE_INTENT_DISTANCE = 4;

export function useEdgeAutoScroll({
	isActive,
	getMouseClientX,
	rulerScrollRef,
	tracksScrollRef,
	contentWidth,
	edgeThreshold = 100,
	maxScrollSpeed = 15,
	onScroll,
}: UseEdgeAutoScrollParams): void {
	const rafRef = useRef<number | null>(null);
	const onScrollRef = useRef(onScroll);
	useEffect(() => {
		onScrollRef.current = onScroll;
	});

	useEffect(() => {
		if (!isActive) {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
			return;
		}

		// Where the pointer was when the drag began. Grabbing something that is
		// already near an edge must not scroll: only moving toward the edge does.
		let startMouseX: number | null = null;

		const step = () => {
			const rulerViewport = rulerScrollRef.current;
			const tracksViewport = tracksScrollRef.current;
			if (!rulerViewport || !tracksViewport) {
				rafRef.current = requestAnimationFrame(step);
				return;
			}

			const viewportRect = rulerViewport.getBoundingClientRect();
			const mouseX = getMouseClientX();
			startMouseX ??= mouseX;
			const mouseXRelative = mouseX - viewportRect.left;
			const movedLeft = mouseX < startMouseX - EDGE_INTENT_DISTANCE;
			const movedRight = mouseX > startMouseX + EDGE_INTENT_DISTANCE;

			const viewportWidth = rulerViewport.clientWidth;
			const intrinsicContentWidth = rulerViewport.scrollWidth;
			const effectiveContentWidth = Math.max(
				contentWidth,
				intrinsicContentWidth,
			);
			const scrollMax = Math.max(0, effectiveContentWidth - viewportWidth);

			let scrollSpeed = 0;

			if (
				movedLeft &&
				mouseXRelative < edgeThreshold &&
				rulerViewport.scrollLeft > 0
			) {
				const edgeDistance = Math.max(0, mouseXRelative);
				const intensity = 1 - edgeDistance / edgeThreshold;
				scrollSpeed = -maxScrollSpeed * intensity;
			} else if (
				movedRight &&
				mouseXRelative > viewportWidth - edgeThreshold &&
				rulerViewport.scrollLeft < scrollMax
			) {
				const edgeDistance = Math.max(0, viewportWidth - mouseXRelative);
				const intensity = 1 - edgeDistance / edgeThreshold;
				scrollSpeed = maxScrollSpeed * intensity;
			}

			if (scrollSpeed !== 0) {
				const newScrollLeft = Math.max(
					0,
					Math.min(scrollMax, rulerViewport.scrollLeft + scrollSpeed),
				);
				if (newScrollLeft !== rulerViewport.scrollLeft) {
					rulerViewport.scrollLeft = newScrollLeft;
					tracksViewport.scrollLeft = newScrollLeft;
					onScrollRef.current?.();
				}
			}

			rafRef.current = requestAnimationFrame(step);
		};

		rafRef.current = requestAnimationFrame(step);

		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [
		isActive,
		getMouseClientX,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth,
		edgeThreshold,
		maxScrollSpeed,
	]);
}
