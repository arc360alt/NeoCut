"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/export";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	type ExportFormat,
	type ExportOptions,
	type ExportQuality,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;
	const lastOptionsRef = useRef<ExportOptions | null>(null);

	// The settings dropdown only picks options; the export itself runs here so
	// closing the dropdown can never cancel it.
	const startExport = useCallback(
		async ({ options }: { options: ExportOptions }) => {
			const project = editor.project.getActiveOrNull();
			if (!project) return;

			lastOptionsRef.current = options;
			setIsExportPopoverOpen(false);
			const result = await editor.project.export({ options });

			if (result.cancelled) {
				editor.project.clearExportState();
				return;
			}
			if (result.success && result.buffer) {
				downloadBuffer({
					buffer: result.buffer,
					filename: `${project.metadata.name}${getExportFileExtension({ format: options.format })}`,
					mimeType: getExportMimeType({ format: options.format }),
				});
				editor.project.clearExportState();
			}
			// Failures stay in the export state; the progress dialog shows them.
		},
		[editor],
	);

	return (
		<>
			<Popover
				open={isExportPopoverOpen}
				onOpenChange={setIsExportPopoverOpen}
			>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={cn(
							"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
							hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
						)}
						onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
						disabled={!hasProject}
						onKeyDown={(event) => {
							if (hasProject && (event.key === "Enter" || event.key === " ")) {
								event.preventDefault();
								setIsExportPopoverOpen(true);
							}
						}}
					>
						<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
							<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
							<span className="z-50 text-[0.875rem]">Export</span>
							<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
								<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
							</div>
						</div>
					</button>
				</PopoverTrigger>
				{hasProject && <ExportPopover onExport={startExport} />}
			</Popover>
			<ExportProgressDialog
				onRetry={() => {
					const options = lastOptionsRef.current;
					if (options) void startExport({ options });
				}}
			/>
		</>
	);
}

/**
 * Shown while exporting. It cannot be dismissed by clicking outside or
 * pressing Escape — only Cancel stops the export — so a stray click can't
 * throw away a long render.
 */
function ExportProgressDialog({ onRetry }: { onRetry: () => void }) {
	const editor = useEditor();
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result } = exportState;
	const hasFailed = !isExporting && !!result && !result.success;
	const isOpen = isExporting || hasFailed;

	// Leaving or reloading the page would also lose the export.
	useEffect(() => {
		if (!isExporting) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [isExporting]);

	const keepOpen = (event: Event) => event.preventDefault();

	return (
		<Dialog open={isOpen}>
			<DialogContent
				className="sm:max-w-md"
				showCloseButton={false}
				onEscapeKeyDown={keepOpen}
				onPointerDownOutside={keepOpen}
				onInteractOutside={keepOpen}
			>
				{hasFailed ? (
					<>
						<DialogHeader>
							<DialogTitle>Export failed</DialogTitle>
						</DialogHeader>
						<ExportError
							error={result?.error || "Unknown error occurred"}
							onRetry={onRetry}
							onClose={() => editor.project.clearExportState()}
						/>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Exporting video</DialogTitle>
							<DialogDescription>
								Keep this tab open until the export finishes.
							</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-4 p-6">
							<div className="flex flex-col gap-2">
								<div className="flex items-center justify-between">
									<p className="text-sm font-medium tabular-nums">
										{Math.round(progress * 100)}%
									</p>
									<p className="text-muted-foreground text-sm">
										{progress >= 1 ? "Finishing…" : "Rendering…"}
									</p>
								</div>
								<Progress value={progress * 100} className="w-full" />
							</div>
							<Button
								variant="outline"
								className="w-full"
								onClick={() => editor.project.cancelExport()}
							>
								Cancel export
							</Button>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ExportPopover({
	onExport,
}: {
	onExport: (args: { options: ExportOptions }) => Promise<void>;
}) {
	const activeProject = useEditor((e) => e.project.getActive());
	const isExporting = useEditor((e) => e.project.getExportState().isExporting);
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);

	const handleExport = () => {
		if (!activeProject) return;
		void onExport({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
			},
		});
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			<>
				<div className="flex items-center justify-between p-3 border-b">
					<h3 className="font-medium text-sm">
						Export project
					</h3>
				</div>

				<div className="flex flex-col gap-4">
					<>
						<div className="flex flex-col">
							<Section
								collapsible
								defaultOpen={false}
								showTopBorder={false}
							>
								<SectionHeader>
									<SectionTitle>Format</SectionTitle>
								</SectionHeader>
								<SectionContent>
									<RadioGroup
										value={format}
										onValueChange={(value) => {
											if (isExportFormat(value)) {
												setFormat(value);
											}
										}}
									>
										<div className="flex items-center space-x-2">
											<RadioGroupItem value="mp4" id="mp4" />
											<Label htmlFor="mp4">
												MP4 (H.264) - Better compatibility
											</Label>
										</div>
										<div className="flex items-center space-x-2">
											<RadioGroupItem value="webm" id="webm" />
											<Label htmlFor="webm">
												WebM (VP9) - Smaller file size
											</Label>
										</div>
									</RadioGroup>
								</SectionContent>
							</Section>

							<Section collapsible defaultOpen={false}>
								<SectionHeader>
									<SectionTitle>Quality</SectionTitle>
								</SectionHeader>
								<SectionContent>
									<RadioGroup
										value={quality}
										onValueChange={(value) => {
											if (isExportQuality(value)) {
												setQuality(value);
											}
										}}
									>
										<div className="flex items-center space-x-2">
											<RadioGroupItem value="low" id="low" />
											<Label htmlFor="low">Low - Smallest file size</Label>
										</div>
										<div className="flex items-center space-x-2">
											<RadioGroupItem value="medium" id="medium" />
											<Label htmlFor="medium">Medium - Balanced</Label>
										</div>
										<div className="flex items-center space-x-2">
											<RadioGroupItem value="high" id="high" />
											<Label htmlFor="high">High - Recommended</Label>
										</div>
										<div className="flex items-center space-x-2">
											<RadioGroupItem value="very_high" id="very_high" />
											<Label htmlFor="very_high">
												Very high - Largest file size
											</Label>
										</div>
									</RadioGroup>
								</SectionContent>
							</Section>

							<Section collapsible defaultOpen={false}>
								<SectionHeader>
									<SectionTitle>Audio</SectionTitle>
								</SectionHeader>
								<SectionContent>
									<div className="flex items-center space-x-2">
										<Checkbox
											id="include-audio"
											checked={shouldIncludeAudio}
											onCheckedChange={(checked) =>
												setShouldIncludeAudio(!!checked)
											}
										/>
										<Label htmlFor="include-audio">
											Include audio in export
										</Label>
									</div>
								</SectionContent>
							</Section>
						</div>

						<div className="p-3 pt-0">
							<Button
								onClick={handleExport}
								disabled={isExporting}
								className="w-full gap-2"
							>
								<Download className="size-4" />
								Export
							</Button>
						</div>
					</>

				</div>
			</>
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
	onClose,
}: {
	error: string;
	onRetry: () => void;
	onClose: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-6">
			<p className="text-muted-foreground text-xs break-words">{error}</p>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onClose}
				>
					Close
				</Button>
			</div>
		</div>
	);
}
