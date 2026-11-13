import { Progress } from "@/components/ui/progress";
import { cn } from "@/utils/ui";
import type { ImportProgress } from "../download";

function describe({ progress }: { progress: ImportProgress }): {
	label: string;
	percent: number | null;
} {
	if (progress.stage === "importing") {
		return { label: "Adding to project…", percent: null };
	}
	if (progress.fraction === null) {
		return { label: "Downloading…", percent: null };
	}
	const percent = Math.round(progress.fraction * 100);
	return { label: `Downloading ${percent}%`, percent };
}

/**
 * Where an import from a remote library is up to. Steps without a measurable
 * percentage show a pulsing full bar, so it never looks stuck.
 */
export function ImportProgressIndicator({
	progress,
	className,
	barClassName,
}: {
	progress: ImportProgress;
	className?: string;
	barClassName?: string;
}) {
	const { label, percent } = describe({ progress });
	return (
		<div
			className={cn("flex w-full flex-col gap-1", className)}
			role="status"
			aria-live="polite"
		>
			<span className="truncate text-xs tabular-nums">{label}</span>
			<Progress
				value={percent ?? 100}
				aria-label={label}
				className={cn("h-1", percent === null && "animate-pulse", barClassName)}
			/>
		</div>
	);
}
