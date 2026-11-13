import type { Transform } from "@/rendering";

/**
 * A child's transform as seen through its parent's: the parent scales and
 * rotates the child's offset from the canvas centre, then moves it.
 *
 * Exact for uniform parent scale; with a non-uniform parent scale and a
 * rotated child the result is the closest rotation + scale (no skew).
 */
export function composeTransforms({
	parent,
	child,
}: {
	parent: Transform;
	child: Transform;
}): Transform {
	const angle = (parent.rotate * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const scaledX = child.position.x * parent.scaleX;
	const scaledY = child.position.y * parent.scaleY;
	return {
		position: {
			x: parent.position.x + scaledX * cos - scaledY * sin,
			y: parent.position.y + scaledX * sin + scaledY * cos,
		},
		scaleX: parent.scaleX * child.scaleX,
		scaleY: parent.scaleY * child.scaleY,
		rotate: parent.rotate + child.rotate,
	};
}
