"use client";

import { useEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { RotateClockwiseIcon } from "@hugeicons/core-free-icons";
import { ElementParamsTab } from "@/components/editor/panels/properties/components/element-params-tab";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { drawAdjustedSource } from "@/services/renderer/adjustments";
import type { TimelineElement } from "@/timeline";
import { cn } from "@/utils/ui";
import {
	ADJUSTMENT_NAMES,
	ADJUSTMENT_PARAM_KEYS,
	ADJUSTMENT_PRESETS,
	NEUTRAL_ADJUSTMENTS,
	buildPresetParams,
	isNeutralAdjustments,
	readAdjustmentsFromParams,
	type AdjustmentPreset,
	type Adjustments,
} from "@/adjustments";

const PRESET_PREVIEW_WIDTH = 96;
const PRESET_PREVIEW_HEIGHT = 54;

let presetSample: OffscreenCanvas | null = null;

/** A small colorful scene, so presets show what they do to skin, sky and foliage. */
function getPresetSample(): OffscreenCanvas {
	if (presetSample) {
		return presetSample;
	}
	const width = PRESET_PREVIEW_WIDTH;
	const height = PRESET_PREVIEW_HEIGHT;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return canvas;
	}
	const sky = ctx.createLinearGradient(0, 0, 0, height);
	sky.addColorStop(0, "#4f9be8");
	sky.addColorStop(0.6, "#f6c28b");
	ctx.fillStyle = sky;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = "#f7d36b";
	ctx.beginPath();
	ctx.arc(width * 0.72, height * 0.38, height * 0.16, 0, Math.PI * 2);
	ctx.fill();
	ctx.fillStyle = "#3f8f4a";
	ctx.beginPath();
	ctx.moveTo(0, height);
	ctx.lineTo(0, height * 0.7);
	ctx.quadraticCurveTo(width * 0.3, height * 0.5, width * 0.55, height * 0.72);
	ctx.quadraticCurveTo(width * 0.8, height * 0.9, width, height * 0.68);
	ctx.lineTo(width, height);
	ctx.closePath();
	ctx.fill();
	ctx.fillStyle = "#d9a07c";
	ctx.beginPath();
	ctx.arc(width * 0.28, height * 0.62, height * 0.13, 0, Math.PI * 2);
	ctx.fill();
	presetSample = canvas;
	return canvas;
}

function PresetPreview({ preset }: { preset: AdjustmentPreset }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const ctx = canvasRef.current?.getContext("2d");
		if (!ctx) {
			return;
		}
		ctx.clearRect(0, 0, PRESET_PREVIEW_WIDTH, PRESET_PREVIEW_HEIGHT);
		drawAdjustedSource({
			ctx,
			source: getPresetSample(),
			width: PRESET_PREVIEW_WIDTH,
			height: PRESET_PREVIEW_HEIGHT,
			adjustments: { ...NEUTRAL_ADJUSTMENTS, ...preset.values },
		});
		if (preset.values.blur) {
			ctx.filter = `blur(${preset.values.blur / 4}px)`;
			ctx.drawImage(ctx.canvas, 0, 0);
			ctx.filter = "none";
		}
	}, [preset]);

	return (
		<canvas
			ref={canvasRef}
			width={PRESET_PREVIEW_WIDTH}
			height={PRESET_PREVIEW_HEIGHT}
			className="aspect-video w-full rounded-sm"
		/>
	);
}

function matchesPreset({
	adjustments,
	preset,
}: {
	adjustments: Adjustments;
	preset: AdjustmentPreset;
}): boolean {
	const target = { ...NEUTRAL_ADJUSTMENTS, ...preset.values };
	return ADJUSTMENT_NAMES.every(
		(name) => adjustments[name] === target[name],
	);
}

/** Presets plus keyframable sliders for an element's color adjustments. */
export function AdjustmentControls({
	element,
	trackId,
}: {
	element: TimelineElement;
	trackId: string;
}) {
	const editor = useEditor();
	const adjustments = readAdjustmentsFromParams({ params: element.params });
	const isNeutral = isNeutralAdjustments({ adjustments });

	const applyPreset = (preset: AdjustmentPreset) =>
		editor.timeline.updateElements({
			updates: [
				{
					trackId,
					elementId: element.id,
					patch: { params: buildPresetParams({ preset }) },
				},
			],
		});

	return (
		<div className="flex flex-col">
			<div className="flex h-11 shrink-0 items-center justify-between border-b px-3.5">
				<SectionTitle>Presets</SectionTitle>
				<Button
					variant="ghost"
					size="sm"
					disabled={isNeutral}
					onClick={() => applyPreset(ADJUSTMENT_PRESETS[0])}
				>
					<HugeiconsIcon icon={RotateClockwiseIcon} />
					Reset
				</Button>
			</div>
			<div
				className="grid gap-2 p-3"
				style={{ gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))" }}
			>
				{ADJUSTMENT_PRESETS.map((preset) => {
					const isActive = matchesPreset({ adjustments, preset });
					return (
						<button
							key={preset.id}
							type="button"
							className="group flex flex-col gap-1 text-left"
							aria-pressed={isActive}
							onClick={() => applyPreset(preset)}
						>
							<span
								className={cn(
									"block overflow-hidden rounded-sm ring-2 ring-transparent transition-shadow",
									isActive ? "ring-primary" : "group-hover:ring-border",
								)}
							>
								<PresetPreview preset={preset} />
							</span>
							<span
								className={cn(
									"truncate text-[0.7rem]",
									isActive ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{preset.name}
							</span>
						</button>
					);
				})}
			</div>
			<ElementParamsTab
				element={element}
				trackId={trackId}
				paramKeys={ADJUSTMENT_PARAM_KEYS}
				sectionKey="adjust"
			/>
		</div>
	);
}
