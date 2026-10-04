"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { TracksSnapshotCommand } from "@/commands/timeline";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useEditor } from "@/editor/use-editor";
import { getClipTimeAtSourceTime } from "@/retime";
import { useElementSelection } from "@/timeline/hooks/element/use-element-selection";
import { cn } from "@/utils/ui";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	DEFAULT_SILENCE_SETTINGS,
	findSilence,
	totalRangeLength,
	type SilenceSettings,
	type TimeRange,
} from "../detect";
import {
	NoAudioError,
	measureClipLevels,
	type ClipLevels,
	type SilenceTargetElement,
} from "../analyze";
import { buildSilenceRemoval } from "../apply";
import { useSilenceDialogStore } from "../silence-dialog-store";

type AnalysisState = { targetKey: string | null } & (
	| { status: "idle" }
	| { status: "analyzing"; progress: number }
	| { status: "ready"; levels: ClipLevels }
	| { status: "error"; message: string }
);

function formatSeconds(seconds: number): string {
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** Source-time ranges (seconds) to clip-time ranges (ticks). */
function toClipRanges({
	ranges,
	element,
}: {
	ranges: TimeRange[];
	element: SilenceTargetElement;
}): TimeRange[] {
	const toClip = (seconds: number) =>
		getClipTimeAtSourceTime({
			sourceTime: seconds * TICKS_PER_SECOND,
			retime: element.retime,
		});
	return ranges.map((range) => ({ start: toClip(range.start), end: toClip(range.end) }));
}

/** Kept and removed parts of the clip, drawn to scale. */
function SilenceBar({
	keep,
	silent,
	duration,
}: {
	keep: TimeRange[];
	silent: TimeRange[];
	duration: number;
}) {
	const segments = [
		...keep.map((range) => ({ ...range, kind: "keep" as const })),
		...silent.map((range) => ({ ...range, kind: "silent" as const })),
	];
	return (
		<div
			className="bg-muted relative h-8 w-full overflow-hidden rounded-sm"
			role="img"
			aria-label="Kept parts of the clip and silent parts to remove"
		>
			{segments.map((segment) => (
				<div
					key={`${segment.kind}-${segment.start}`}
					className={cn(
						"absolute inset-y-0",
						segment.kind === "keep" ? "bg-primary/70" : "bg-destructive/40",
					)}
					style={{
						left: `${(segment.start / duration) * 100}%`,
						width: `${((segment.end - segment.start) / duration) * 100}%`,
					}}
				/>
			))}
		</div>
	);
}

function SettingSlider({
	id,
	label,
	value,
	display,
	min,
	max,
	step,
	hint,
	onChange,
}: {
	id: string;
	label: string;
	value: number;
	display: string;
	min: number;
	max: number;
	step: number;
	hint: string;
	onChange: (value: number) => void;
}) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<Label htmlFor={id}>{label}</Label>
				<span className="text-muted-foreground font-mono text-xs tabular-nums">
					{display}
				</span>
			</div>
			<Slider
				id={id}
				value={[value]}
				min={min}
				max={max}
				step={step}
				onValueChange={([next]) => onChange(next)}
			/>
			<p className="text-muted-foreground text-xs">{hint}</p>
		</div>
	);
}

export function SilenceDialog() {
	const isOpen = useSilenceDialogStore((state) => state.isOpen);
	const setOpen = useSilenceDialogStore((state) => state.setOpen);

	return (
		<Dialog open={isOpen} onOpenChange={(open) => setOpen({ isOpen: open })}>
			<DialogContent className="sm:max-w-lg">
				{isOpen && <SilenceDialogBody onClose={() => setOpen({ isOpen: false })} />}
			</DialogContent>
		</Dialog>
	);
}

function SilenceDialogBody({ onClose }: { onClose: () => void }) {
	const editor = useEditor();
	const { selectedElements } = useElementSelection();
	const [settings, setSettings] = useState<SilenceSettings>(DEFAULT_SILENCE_SETTINGS);
	const [closeGaps, setCloseGaps] = useState(true);
	const [storedAnalysis, setAnalysis] = useState<AnalysisState>({
		targetKey: null,
		status: "idle",
	});
	const abortRef = useRef<AbortController | null>(null);

	const selected =
		selectedElements.length === 1
			? editor.timeline.getElementsWithTracks({ elements: selectedElements })[0]
			: undefined;
	const target =
		selected &&
		(selected.element.type === "video" || selected.element.type === "audio")
			? { element: selected.element, trackId: selected.track.id }
			: null;

	// Measurements belong to one clip; selecting another one discards them.
	const targetKey = target
		? `${target.element.id}:${target.element.trimStart}:${target.element.duration}`
		: null;
	const analysis: AnalysisState =
		storedAnalysis.targetKey === targetKey
			? storedAnalysis
			: { targetKey, status: "idle" };
	useEffect(() => {
		abortRef.current?.abort();
	}, [targetKey]);
	useEffect(() => () => abortRef.current?.abort(), []);

	const result = useMemo(() => {
		if (
			storedAnalysis.status !== "ready" ||
			storedAnalysis.targetKey !== targetKey
		) {
			return null;
		}
		return findSilence({
			levels: storedAnalysis.levels.levels,
			duration: storedAnalysis.levels.duration,
			settings,
		});
	}, [storedAnalysis, targetKey, settings]);

	const analyze = async () => {
		if (!target) return;
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		const key = targetKey;
		setAnalysis({ targetKey: key, status: "analyzing", progress: 0 });
		try {
			const levels = await measureClipLevels({
				element: target.element,
				mediaAssets: editor.media.getAssets(),
				signal: controller.signal,
				onProgress: (progress) =>
					setAnalysis((previous) =>
						previous.status === "analyzing" && previous.targetKey === key
							? { targetKey: key, status: "analyzing", progress }
							: previous,
					),
			});
			if (!controller.signal.aborted) {
				setAnalysis({ targetKey: key, status: "ready", levels });
			}
		} catch (error) {
			if (controller.signal.aborted) return;
			console.error("Silence analysis failed:", error);
			setAnalysis({
				targetKey: key,
				status: "error",
				message:
					error instanceof NoAudioError
						? error.message
						: "Couldn't read this clip's audio.",
			});
		}
	};

	const removeSilence = () => {
		if (!target || !result) return;
		const before = editor.scenes.getActiveScene().tracks;
		const removal = buildSilenceRemoval({
			tracks: before,
			trackId: target.trackId,
			elementId: target.element.id,
			keep: toClipRanges({ ranges: result.keep, element: target.element }),
			closeGaps,
		});
		if (!removal) {
			toast.info("No silence to remove with these settings");
			return;
		}

		editor.command.execute({
			command: new TracksSnapshotCommand({ before, after: removal.tracks }),
		});
		// Selecting every piece of a long edit would keep them all mounted.
		editor.selection.setSelectedElements({
			elements: removal.pieceIds
				.slice(0, 1)
				.map((elementId) => ({ trackId: target.trackId, elementId })),
		});
		toast.success(
			`Removed ${formatSeconds(removal.removedDuration / TICKS_PER_SECOND)} of silence`,
		);
		onClose();
	};

	const update = (patch: Partial<SilenceSettings>) =>
		setSettings((previous) => ({ ...previous, ...patch }));

	const removedSeconds = result ? totalRangeLength({ ranges: result.silent }) : 0;

	return (
		<>
			<DialogHeader>
				<DialogTitle>Remove silence</DialogTitle>
				<DialogDescription>
					Finds quiet parts of the selected clip and cuts them out.
				</DialogDescription>
			</DialogHeader>
			<DialogBody className="gap-5">
				{target ? (
					<p className="text-sm">
						Clip: <span className="font-medium">{target.element.name}</span>{" "}
						<span className="text-muted-foreground">
							({formatSeconds(target.element.duration / TICKS_PER_SECOND)})
						</span>
					</p>
				) : (
					<p className="text-destructive text-sm">
						Select one video or audio clip on the timeline first.
					</p>
				)}

				<SettingSlider
					id="silence-threshold"
					label="Silence threshold"
					value={settings.thresholdDb}
					display={`${settings.thresholdDb} dB`}
					min={-80}
					max={-10}
					step={1}
					hint="Anything quieter than this counts as silence. Raise it for noisy recordings."
					onChange={(thresholdDb) => update({ thresholdDb })}
				/>
				<SettingSlider
					id="silence-min-duration"
					label="Minimum silence length"
					value={settings.minSilenceSeconds}
					display={`${settings.minSilenceSeconds.toFixed(2)} s`}
					min={0.1}
					max={5}
					step={0.05}
					hint="Shorter pauses, like gaps between words, are kept."
					onChange={(minSilenceSeconds) => update({ minSilenceSeconds })}
				/>
				<SettingSlider
					id="silence-padding"
					label="Padding"
					value={settings.paddingSeconds}
					display={`${settings.paddingSeconds.toFixed(2)} s`}
					min={0}
					max={1}
					step={0.01}
					hint="Audio kept around each cut so words aren't clipped."
					onChange={(paddingSeconds) => update({ paddingSeconds })}
				/>
				<div className="flex items-center justify-between gap-4">
					<div className="flex flex-col gap-1">
						<Label htmlFor="silence-close-gaps">Close gaps</Label>
						<p className="text-muted-foreground text-xs">
							Pull the remaining parts and later clips on this track together.
						</p>
					</div>
					<Switch
						id="silence-close-gaps"
						checked={closeGaps}
						onCheckedChange={setCloseGaps}
					/>
				</div>

				{analysis.status === "analyzing" && (
					<div className="flex flex-col gap-2">
						<Progress value={analysis.progress * 100} />
						<p className="text-muted-foreground text-xs">
							Analyzing audio… {Math.round(analysis.progress * 100)}%
						</p>
					</div>
				)}
				{analysis.status === "error" && (
					<p className="text-destructive text-sm">{analysis.message}</p>
				)}
				{result && (
					<div className="flex flex-col gap-2">
						<SilenceBar
							keep={result.keep}
							silent={result.silent}
							duration={result.duration}
						/>
						<p className="text-muted-foreground text-xs">
							{result.silent.length === 0
								? "No silence found with these settings."
								: `${result.silent.length} silent ${result.silent.length === 1 ? "part" : "parts"} · ${formatSeconds(removedSeconds)} removed (${Math.round((removedSeconds / Math.max(result.duration, 0.001)) * 100)}% of the clip)`}
						</p>
					</div>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="outline" onClick={onClose}>
					Cancel
				</Button>
				{result ? (
					<Button
						onClick={removeSilence}
						disabled={result.silent.length === 0}
					>
						Remove silence
					</Button>
				) : (
					<Button
						onClick={() => void analyze()}
						disabled={!target || analysis.status === "analyzing"}
					>
						{analysis.status === "analyzing" ? "Analyzing…" : "Analyze"}
					</Button>
				)}
			</DialogFooter>
		</>
	);
}
