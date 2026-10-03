import type { ParamDefinition } from "@/params";
import { applyAlignedStroke } from "../stroke";
import { STROKE_ALIGN_PARAM, type GraphicStrokeAlign } from "./shared";
import type { GraphicDefinition } from "../types";

type Point = [number, number];

interface ShapeFrame {
	point(point: Point): Point;
	scale(length: number): number;
}

interface PathShapeSpec {
	id: string;
	name: string;
	keywords: string[];
	viewBox: { width: number; height: number };
	trace(context: { path: Path2D; frame: ShapeFrame }): void;
}

const PATH_SHAPE_PARAMS: ParamDefinition[] = [
	{
		key: "fill",
		label: "Fill",
		type: "color",
		default: "#ffffff",
	},
	{
		key: "stroke",
		label: "Color",
		type: "color",
		default: "#000000",
		group: "stroke",
	},
	{
		key: "strokeWidth",
		label: "Width",
		type: "number",
		default: 0,
		min: 0,
		max: 64,
		step: 1,
		shortLabel: "W",
		group: "stroke",
	},
	STROKE_ALIGN_PARAM,
];

function createShapeFrame({
	width,
	height,
	inset,
	viewBox,
}: {
	width: number;
	height: number;
	inset: number;
	viewBox: { width: number; height: number };
}): ShapeFrame {
	const availableWidth = Math.max(1, width - inset * 2);
	const availableHeight = Math.max(1, height - inset * 2);
	const scale = Math.min(
		availableWidth / viewBox.width,
		availableHeight / viewBox.height,
	);
	const offsetX = (width - viewBox.width * scale) / 2;
	const offsetY = (height - viewBox.height * scale) / 2;
	return {
		point: ([x, y]) => [offsetX + x * scale, offsetY + y * scale],
		scale: (length) => length * scale,
	};
}

function tracePolygon({
	path,
	frame,
	points,
}: {
	path: Path2D;
	frame: ShapeFrame;
	points: Point[];
}): void {
	path.moveTo(...frame.point(points[0]));
	for (let index = 1; index < points.length; index++) {
		path.lineTo(...frame.point(points[index]));
	}
	path.closePath();
}

function polygonShape({
	points,
	...spec
}: Omit<PathShapeSpec, "trace"> & { points: Point[] }): PathShapeSpec {
	return {
		...spec,
		trace: ({ path, frame }) => tracePolygon({ path, frame, points }),
	};
}

function readStrokeAlign(value: unknown): GraphicStrokeAlign {
	return value === "inside" || value === "outside" ? value : "center";
}

function definePathShape(spec: PathShapeSpec): GraphicDefinition {
	return {
		id: spec.id,
		name: spec.name,
		keywords: spec.keywords,
		params: PATH_SHAPE_PARAMS,
		render({ ctx, params, width, height }) {
			const fill = String(params.fill ?? "#ffffff");
			const stroke = String(params.stroke ?? "#000000");
			const strokeWidth = Math.max(0, Number(params.strokeWidth ?? 0));
			const strokeAlign = readStrokeAlign(params.strokeAlign);
			const inset =
				strokeAlign === "center"
					? strokeWidth / 2
					: strokeAlign === "outside"
						? strokeWidth
						: 0;
			const frame = createShapeFrame({
				width,
				height,
				inset,
				viewBox: spec.viewBox,
			});

			ctx.clearRect(0, 0, width, height);
			const path = new Path2D();
			spec.trace({ path, frame });
			ctx.fillStyle = fill;
			ctx.fill(path);

			if (strokeWidth > 0) {
				applyAlignedStroke({
					ctx,
					path,
					strokeWidth,
					strokeAlign,
					strokeColor: stroke,
				});
			}
		},
	};
}

export const arrowGraphicDefinition = definePathShape(
	polygonShape({
		id: "arrow",
		name: "Arrow",
		keywords: ["arrow", "right", "direction", "pointer", "next"],
		viewBox: { width: 100, height: 60 },
		points: [
			[0, 18],
			[58, 18],
			[58, 0],
			[100, 30],
			[58, 60],
			[58, 42],
			[0, 42],
		],
	}),
);

export const doubleArrowGraphicDefinition = definePathShape(
	polygonShape({
		id: "double-arrow",
		name: "Double Arrow",
		keywords: ["arrow", "double", "both", "left", "right", "swap"],
		viewBox: { width: 100, height: 60 },
		points: [
			[0, 30],
			[30, 0],
			[30, 18],
			[70, 18],
			[70, 0],
			[100, 30],
			[70, 60],
			[70, 42],
			[30, 42],
			[30, 60],
		],
	}),
);

export const chevronGraphicDefinition = definePathShape(
	polygonShape({
		id: "chevron",
		name: "Chevron",
		keywords: ["chevron", "arrow", "caret", "next", "angle"],
		viewBox: { width: 60, height: 100 },
		points: [
			[0, 0],
			[28, 0],
			[60, 50],
			[28, 100],
			[0, 100],
			[32, 50],
		],
	}),
);

export const heartGraphicDefinition = definePathShape({
	id: "heart",
	name: "Heart",
	keywords: ["heart", "love", "like", "favorite"],
	viewBox: { width: 100, height: 90 },
	trace({ path, frame }) {
		const p = frame.point;
		path.moveTo(...p([50, 90]));
		path.bezierCurveTo(...p([20, 68]), ...p([0, 48]), ...p([0, 27]));
		path.bezierCurveTo(...p([0, 10]), ...p([13, 0]), ...p([27, 0]));
		path.bezierCurveTo(...p([38, 0]), ...p([46, 6]), ...p([50, 14]));
		path.bezierCurveTo(...p([54, 6]), ...p([62, 0]), ...p([73, 0]));
		path.bezierCurveTo(...p([87, 0]), ...p([100, 10]), ...p([100, 27]));
		path.bezierCurveTo(...p([100, 48]), ...p([80, 68]), ...p([50, 90]));
		path.closePath();
	},
});

export const plusGraphicDefinition = definePathShape(
	polygonShape({
		id: "plus",
		name: "Plus",
		keywords: ["plus", "add", "cross", "positive"],
		viewBox: { width: 100, height: 100 },
		points: [
			[33, 0],
			[67, 0],
			[67, 33],
			[100, 33],
			[100, 67],
			[67, 67],
			[67, 100],
			[33, 100],
			[33, 67],
			[0, 67],
			[0, 33],
			[33, 33],
		],
	}),
);

export const crossGraphicDefinition = definePathShape(
	polygonShape({
		id: "cross",
		name: "Cross",
		keywords: ["cross", "x", "close", "wrong", "no", "cancel"],
		viewBox: { width: 100, height: 100 },
		points: [
			[0, 15],
			[15, 0],
			[50, 35],
			[85, 0],
			[100, 15],
			[65, 50],
			[100, 85],
			[85, 100],
			[50, 65],
			[15, 100],
			[0, 85],
			[35, 50],
		],
	}),
);

export const checkmarkGraphicDefinition = definePathShape(
	polygonShape({
		id: "checkmark",
		name: "Checkmark",
		keywords: ["check", "checkmark", "tick", "done", "yes", "correct"],
		viewBox: { width: 100, height: 78 },
		points: [
			[0, 42],
			[14, 28],
			[36, 50],
			[86, 0],
			[100, 14],
			[36, 78],
		],
	}),
);

export const lightningGraphicDefinition = definePathShape(
	polygonShape({
		id: "lightning",
		name: "Lightning",
		keywords: ["lightning", "bolt", "flash", "thunder", "energy", "zap"],
		viewBox: { width: 64, height: 100 },
		points: [
			[38, 0],
			[0, 58],
			[28, 58],
			[20, 100],
			[64, 40],
			[36, 40],
			[50, 0],
		],
	}),
);

export const speechBubbleGraphicDefinition = definePathShape({
	id: "speech-bubble",
	name: "Speech Bubble",
	keywords: ["speech", "bubble", "chat", "talk", "comment", "callout", "message"],
	viewBox: { width: 100, height: 90 },
	trace({ path, frame }) {
		const p = frame.point;
		const radius = frame.scale(14);
		path.moveTo(...p([14, 0]));
		path.lineTo(...p([86, 0]));
		path.arcTo(...p([100, 0]), ...p([100, 14]), radius);
		path.lineTo(...p([100, 56]));
		path.arcTo(...p([100, 70]), ...p([86, 70]), radius);
		path.lineTo(...p([44, 70]));
		path.lineTo(...p([18, 90]));
		path.lineTo(...p([24, 70]));
		path.lineTo(...p([14, 70]));
		path.arcTo(...p([0, 70]), ...p([0, 56]), radius);
		path.lineTo(...p([0, 14]));
		path.arcTo(...p([0, 0]), ...p([14, 0]), radius);
		path.closePath();
	},
});

export const ringGraphicDefinition = definePathShape({
	id: "ring",
	name: "Ring",
	keywords: ["ring", "donut", "circle", "outline", "hoop"],
	viewBox: { width: 100, height: 100 },
	trace({ path, frame }) {
		const [centerX, centerY] = frame.point([50, 50]);
		const outerRadius = frame.scale(50);
		const innerRadius = frame.scale(32);
		path.moveTo(centerX + outerRadius, centerY);
		path.arc(centerX, centerY, outerRadius, 0, Math.PI * 2);
		path.closePath();
		// Opposite winding cuts the hole under the nonzero fill rule.
		path.moveTo(centerX + innerRadius, centerY);
		path.arc(centerX, centerY, innerRadius, 0, Math.PI * 2, true);
		path.closePath();
	},
});

export const pathShapeGraphicDefinitions = [
	arrowGraphicDefinition,
	doubleArrowGraphicDefinition,
	chevronGraphicDefinition,
	heartGraphicDefinition,
	plusGraphicDefinition,
	crossGraphicDefinition,
	checkmarkGraphicDefinition,
	lightningGraphicDefinition,
	speechBubbleGraphicDefinition,
	ringGraphicDefinition,
];
