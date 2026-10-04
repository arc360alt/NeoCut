import { useEffect, useState } from "react";
import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import { TICKS_PER_SECOND } from "@/wasm";

export interface VisibleTimeRange {
	start: number;
	end: number;
}

/**
 * The span of timeline time worth rendering: the visible part plus one
 * viewport width on each side. The window moves in viewport-sized steps,
 * so scrolling only re-renders when it crosses into the next step.
 */
export function useVisibleTimeRange({
	scrollRef,
	zoomLevel,
}: {
	scrollRef: React.RefObject<HTMLElement | null>;
	zoomLevel: number;
}): VisibleTimeRange | null {
	const [window, setWindow] = useState<{ page: number; width: number } | null>(
		null,
	);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;

		let frame: number | null = null;
		const update = () => {
			frame = null;
			const width = Math.max(1, element.clientWidth);
			const page = Math.floor(element.scrollLeft / width);
			setWindow((previous) =>
				previous && previous.page === page && previous.width === width
					? previous
					: { page, width },
			);
		};
		const schedule = () => {
			if (frame === null) {
				frame = requestAnimationFrame(update);
			}
		};

		update();
		element.addEventListener("scroll", schedule, { passive: true });
		const resizeObserver = new ResizeObserver(schedule);
		resizeObserver.observe(element);
		return () => {
			element.removeEventListener("scroll", schedule);
			resizeObserver.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [scrollRef]);

	if (!window) {
		return null;
	}

	const ticksPerPixel =
		TICKS_PER_SECOND / getTimelinePixelsPerSecond({ zoomLevel });
	return {
		start: Math.max(0, (window.page - 1) * window.width * ticksPerPixel),
		end: (window.page + 3) * window.width * ticksPerPixel,
	};
}
