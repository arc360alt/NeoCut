"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	ArrowRightDoubleIcon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import type {
	NumberParamDefinition,
	ParamValue,
	SelectParamDefinition,
} from "@/params";
import type { TransitionableElement } from "@/timeline";
import { useEditor } from "@/editor/use-editor";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import { findTrackInSceneTracks } from "@/timeline";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import {
	MAX_TRANSITION_DURATION_SECONDS,
	MIN_TRANSITION_DURATION_SECONDS,
	buildTransition,
	findTransitionDefinition,
	getTrackCuts,
	getTransitionDefinitions,
} from "@/transitions";

const DURATION_PARAM: NumberParamDefinition = {
	key: "duration",
	label: "Duration (s)",
	type: "number",
	default: 0.5,
	min: MIN_TRANSITION_DURATION_SECONDS,
	max: MAX_TRANSITION_DURATION_SECONDS,
	step: 0.05,
	keyframable: false,
};

export function TransitionTab({
	element,
	trackId,
}: {
	element: TransitionableElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});
	const transition = (renderElement as TransitionableElement).transitionIn;

	const track = findTrackInSceneTracks({
		tracks: editor.scenes.getActiveScene().tracks,
		trackId,
	});
	const hasPreviousClip = track
		? getTrackCuts({ elements: track.elements }).some(
				(cut) => cut.to.id === element.id,
			)
		: false;

	if (!transition) {
		return <EmptyView hasPreviousClip={hasPreviousClip} />;
	}

	const definition = findTransitionDefinition({ type: transition.type });
	const typeParam: SelectParamDefinition = {
		key: "type",
		label: "Style",
		type: "select",
		default: "fade",
		keyframable: false,
		options: getTransitionDefinitions().map((candidate) => ({
			value: candidate.type,
			label: candidate.name,
		})),
	};

	const previewTransition = (patch: Partial<typeof transition>) =>
		previewUpdates({ transitionIn: { ...transition, ...patch } });

	const handleTypeChange = (value: ParamValue) => {
		const next = buildTransition({ type: String(value) });
		previewUpdates({
			transitionIn: { ...next, duration: transition.duration },
		});
	};

	const handleDurationChange = (value: ParamValue) => {
		const seconds = Math.min(
			MAX_TRANSITION_DURATION_SECONDS,
			Math.max(MIN_TRANSITION_DURATION_SECONDS, Number(value)),
		);
		previewTransition({ duration: mediaTimeFromSeconds({ seconds }) });
	};

	const handleParamChange = (key: string) => (value: ParamValue) =>
		previewTransition({ params: { ...transition.params, [key]: value } });

	return (
		<div className="flex h-full flex-col">
			<Section sectionKey={`${element.id}:transition`} showTopBorder={false}>
				<SectionHeader
					trailing={
						<Button
							variant="ghost"
							size="icon"
							aria-label="Remove transition"
							onClick={() =>
								editor.timeline.setElementTransition({
									trackId,
									elementId: element.id,
									transition: undefined,
								})
							}
						>
							<HugeiconsIcon icon={Delete02Icon} />
						</Button>
					}
				>
					<SectionTitle>Transition in</SectionTitle>
				</SectionHeader>
				<SectionContent className="p-0">
					{!hasPreviousClip && (
						<p className="text-muted-foreground px-4 pb-3 text-xs">
							Inactive: no clip ends where this one starts. Move a clip next to
							it to play this transition.
						</p>
					)}
					<SectionFields>
						<ParamRow>
							<PropertyParamField
								param={typeParam}
								value={transition.type}
								onPreview={handleTypeChange}
								onCommit={commit}
							/>
						</ParamRow>
						<ParamRow>
							<PropertyParamField
								param={DURATION_PARAM}
								value={mediaTimeToSeconds({ time: transition.duration })}
								onPreview={handleDurationChange}
								onCommit={commit}
							/>
						</ParamRow>
						{definition?.params.map((param) => (
							<ParamRow key={param.key}>
								<PropertyParamField
									param={param}
									value={transition.params[param.key] ?? param.default}
									onPreview={handleParamChange(param.key)}
									onCommit={commit}
								/>
							</ParamRow>
						))}
					</SectionFields>
				</SectionContent>
			</Section>
		</div>
	);
}

function ParamRow({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-3.5">
			<div className="px-4">{children}</div>
			<Separator />
		</div>
	);
}

function EmptyView({ hasPreviousClip }: { hasPreviousClip: boolean }) {
	const setActiveTab = useAssetsPanelStore((s) => s.setActiveTab);

	return (
		<div className="flex h-full flex-col items-center justify-center gap-4 text-center">
			<HugeiconsIcon
				icon={ArrowRightDoubleIcon}
				className="text-muted-foreground size-10"
				strokeWidth={1}
			/>
			<div className="flex flex-col gap-2">
				<h3 className="text-foreground font-medium">No transition</h3>
				<p className="text-muted-foreground max-w-44 text-sm text-balance">
					{hasPreviousClip
						? "Drag a transition onto the cut before this clip."
						: "Place this clip right after another one to add a transition."}
				</p>
			</div>
			<Button
				variant="default"
				size="sm"
				onClick={() => setActiveTab("transitions")}
			>
				Open transitions
			</Button>
		</div>
	);
}
