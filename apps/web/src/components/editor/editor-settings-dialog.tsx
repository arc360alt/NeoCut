"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";
import {
	GithubIcon,
	InformationCircleIcon,
	KeyboardIcon,
	Settings02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ShortcutsEditor } from "@/actions/components/shortcuts-dialog";
import { useTimelineStore } from "@/timeline/timeline-store";
import {
	isSoftwareVideoDecodingEnabled,
	setSoftwareVideoDecoding,
} from "@/media/video-decoding";
import { isGpuAvailable } from "@/services/renderer/gpu-renderer";
import { BUILD_INFO } from "@/site/build-info";
import { SOCIAL_LINKS } from "@/site/social";
import { SITE_INFO } from "@/site/brand";

export function EditorSettingsButton() {
	const [isOpen, setIsOpen] = useState(false);

	return (
		<>
			<Button
				size="icon"
				variant="ghost"
				className="size-8"
				onClick={() => setIsOpen(true)}
				title="Settings"
			>
				<HugeiconsIcon icon={Settings02Icon} className="!size-[1.1rem]" />
				<span className="sr-only">Settings</span>
			</Button>
			<EditorSettingsDialog isOpen={isOpen} onOpenChange={setIsOpen} />
		</>
	);
}

function EditorSettingsDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[80vh] max-h-[40rem] max-w-2xl flex-col gap-0 p-0">
				<DialogHeader className="border-b-0 px-6 pt-5 pb-3">
					<DialogTitle>Settings</DialogTitle>
				</DialogHeader>
				<Tabs
					defaultValue="general"
					variant="underline"
					className="flex min-h-0 grow flex-col"
				>
					<TabsList className="shrink-0 px-3">
						<TabsTrigger value="general" className="gap-1.5">
							<HugeiconsIcon icon={Settings02Icon} className="size-4" />
							General
						</TabsTrigger>
						<TabsTrigger value="shortcuts" className="gap-1.5">
							<HugeiconsIcon icon={KeyboardIcon} className="size-4" />
							Shortcuts
						</TabsTrigger>
						<TabsTrigger value="about" className="gap-1.5">
							<HugeiconsIcon icon={InformationCircleIcon} className="size-4" />
							About
						</TabsTrigger>
					</TabsList>
					<TabsContent
						value="general"
						className="scrollbar-thin min-h-0 grow overflow-y-auto px-6 py-5"
					>
						<GeneralSettings />
					</TabsContent>
					<TabsContent
						value="shortcuts"
						className="flex min-h-0 grow flex-col px-0 data-[state=inactive]:hidden"
					>
						<ShortcutsEditor
							listClassName="scrollbar-thin min-h-0 grow overflow-y-auto px-6 py-5"
							footerClassName="border-t px-6 py-4"
						/>
					</TabsContent>
					<TabsContent
						value="about"
						className="scrollbar-thin min-h-0 grow overflow-y-auto px-6 py-5"
					>
						<AboutSettings />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

/* ---------------------------------------------------------------- General */

function GeneralSettings() {
	const { theme, setTheme } = useTheme();
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);
	const [softwareDecoding, setSoftwareDecodingState] = useState(() =>
		isSoftwareVideoDecodingEnabled(),
	);

	return (
		<div className="flex flex-col gap-5">
			<SettingsGroup title="Appearance">
				<SettingRow label="Theme" description="Light, dark, or follow your system.">
					<ToggleGroup
						type="single"
						size="sm"
						className="bg-muted/40 gap-0.5 rounded-md border p-0.5"
						value={theme ?? "system"}
						onValueChange={(value) => {
							if (value) setTheme(value);
						}}
					>
						{(["light", "dark", "system"] as const).map((value) => (
							<ToggleGroupItem
								key={value}
								value={value}
								className="h-7 rounded-sm px-3 capitalize data-[state=on]:bg-background data-[state=on]:shadow-xs"
							>
								{value}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</SettingRow>
			</SettingsGroup>

			<SettingsGroup title="Timeline">
				<SettingRow
					label="Snapping"
					description="Snap clips to the playhead and to other clips' edges."
				>
					<SettingSwitch checked={snappingEnabled} onCheckedChange={toggleSnapping} />
				</SettingRow>
				<SettingRow
					label="Ripple editing"
					description="Deleting or trimming a clip shifts the clips after it."
				>
					<SettingSwitch
						checked={rippleEditingEnabled}
						onCheckedChange={toggleRippleEditing}
					/>
				</SettingRow>
			</SettingsGroup>

			<SettingsGroup title="Playback">
				<SettingRow
					label="Software video decoding"
					description="Decode video on the CPU instead of the GPU. Slower, but fixes videos that fail to play on some GPU drivers. Turns on automatically after a hardware decoding failure."
				>
					<SettingSwitch
						checked={softwareDecoding}
						onCheckedChange={(enabled) => {
							setSoftwareVideoDecoding({ enabled });
							setSoftwareDecodingState(enabled);
						}}
					/>
				</SettingRow>
			</SettingsGroup>
		</div>
	);
}

/** The shared Switch's off track blends into dark backgrounds; give it contrast here. */
function SettingSwitch(props: React.ComponentProps<typeof Switch>) {
	return (
		<Switch
			className="data-[state=unchecked]:bg-foreground/20"
			{...props}
		/>
	);
}

function SettingsGroup({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3 not-first:border-t not-first:pt-5">
			<h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				{title}
			</h3>
			<div className="flex flex-col gap-4">{children}</div>
		</section>
	);
}

function SettingRow({
	label,
	description,
	children,
}: {
	label: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
			<div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
				<span className="text-sm font-medium">{label}</span>
				{description && (
					<span className="text-muted-foreground text-xs">{description}</span>
				)}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

/* ------------------------------------------------------------------ About */

type GpuBackend = "webgpu" | "webgl" | "none";

type CommitDetails = {
	message: string;
	author: string;
	date: string;
	url: string;
};

type CommitState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; commit: CommitDetails; latestSha: string | null };

function getGithubRepo(): { owner: string; repo: string } | null {
	const match = SOCIAL_LINKS.github.match(/github\.com\/([^/]+)\/([^/#?]+)/);
	if (!match) return null;
	return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

async function detectGpuBackend(): Promise<GpuBackend> {
	if (!isGpuAvailable()) return "none";
	// The Rust GPU context asks for WebGPU first and falls back to WebGL 2
	// only when no WebGPU adapter is available, so mirror that check.
	const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
	if (!gpu) return "webgl";
	try {
		return (await gpu.requestAdapter()) ? "webgpu" : "webgl";
	} catch {
		return "webgl";
	}
}

function useGpuBackend(): GpuBackend | null {
	const [backend, setBackend] = useState<GpuBackend | null>(null);
	useEffect(() => {
		let cancelled = false;
		void detectGpuBackend().then((result) => {
			if (!cancelled) setBackend(result);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return backend;
}

function useCommitDetails(sha: string): CommitState | null {
	const [state, setState] = useState<CommitState | null>(null);

	useEffect(() => {
		const repo = getGithubRepo();
		if (!sha || !repo) return;

		const controller = new AbortController();
		const base = `https://api.github.com/repos/${repo.owner}/${repo.repo}`;
		const headers = { Accept: "application/vnd.github+json" };

		(async () => {
			try {
				const [commitResponse, latestResponse] = await Promise.all([
					fetch(`${base}/commits/${sha}`, { headers, signal: controller.signal }),
					BUILD_INFO.branch
						? fetch(`${base}/commits/${encodeURIComponent(BUILD_INFO.branch)}`, {
								headers,
								signal: controller.signal,
							})
						: Promise.resolve(null),
				]);

				if (!commitResponse.ok) {
					setState({
						status: "error",
						message:
							commitResponse.status === 404 || commitResponse.status === 422
								? "This commit isn't on GitHub (not pushed yet?)."
								: `GitHub returned ${commitResponse.status}.`,
					});
					return;
				}

				const commit = parseCommit(await commitResponse.json());
				if (!commit) {
					setState({ status: "error", message: "Unexpected response from GitHub." });
					return;
				}
				const latest = latestResponse?.ok
					? readString({ data: await latestResponse.json(), keys: ["sha"] })
					: null;

				setState({ status: "ready", commit, latestSha: latest });
			} catch (error) {
				if (controller.signal.aborted) return;
				setState({
					status: "error",
					message: error instanceof Error ? error.message : "Request failed.",
				});
			}
		})();

		return () => controller.abort();
	}, [sha]);

	return state;
}

/** Reads a string at a nested key path of untrusted JSON, or null. */
function readString({
	data,
	keys,
}: {
	data: unknown;
	keys: string[];
}): string | null {
	let current: unknown = data;
	for (const key of keys) {
		if (typeof current !== "object" || current === null) return null;
		current = Reflect.get(current, key);
	}
	return typeof current === "string" ? current : null;
}

function parseCommit(data: unknown): CommitDetails | null {
	const message = readString({ data, keys: ["commit", "message"] });
	const author = readString({ data, keys: ["commit", "author", "name"] });
	const date = readString({ data, keys: ["commit", "author", "date"] });
	const url = readString({ data, keys: ["html_url"] });
	if (message === null || author === null || date === null || url === null) {
		return null;
	}
	return { message, author, date, url };
}

function formatDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function AboutSettings() {
	const backend = useGpuBackend();
	const sha = BUILD_INFO.commitSha;
	const commitState = useCommitDetails(sha);
	const repoUrl = SOCIAL_LINKS.github;

	const engineLabel =
		backend === null
			? "Checking…"
			: backend === "none"
				? "JS (Canvas 2D fallback)"
				: "WASM";
	const backendLabel =
		backend === null
			? "Checking…"
			: backend === "webgpu"
				? "WebGPU"
				: backend === "webgl"
					? "WebGL 2"
					: "Unavailable";
	const wasmBuildLabel =
		BUILD_INFO.wasmSource === "local"
			? "Local build from rust/wasm"
			: BUILD_INFO.wasmSource === "npm"
				? "Published npm package"
				: "Unknown";

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-1">
				<span className="text-lg font-semibold">{SITE_INFO.title}</span>
				<span className="text-muted-foreground text-sm">
					{SITE_INFO.description}
				</span>
			</div>

			<SettingsGroup title="Engine">
				<InfoGrid
					rows={[
						["Renderer", engineLabel],
						["GPU backend", backendLabel],
						[
							"WASM package",
							BUILD_INFO.wasmVersion
								? `opencut-wasm ${BUILD_INFO.wasmVersion}`
								: "opencut-wasm",
						],
						["WASM build", wasmBuildLabel],
					]}
				/>
				{backend === "none" && (
					<p className="text-muted-foreground text-xs">
						The GPU couldn&apos;t be initialised, so effects, masks and blur
						backgrounds won&apos;t render. Try a Chromium-based browser with hardware
						acceleration turned on.
					</p>
				)}
			</SettingsGroup>

			<SettingsGroup title="Build">
				<InfoGrid
					rows={[
						["Branch", BUILD_INFO.branch || "Unknown"],
						[
							"Commit",
							sha ? (
								<code key="sha" className="font-mono text-xs">
									{sha.slice(0, 7)}
								</code>
							) : (
								"Unknown"
							),
						],
						[
							"Built",
							BUILD_INFO.buildTime ? formatDate(BUILD_INFO.buildTime) : "Unknown",
						],
					]}
				/>
				<CommitCard state={commitState} sha={sha} />
			</SettingsGroup>

			<div>
				<Button variant="outline" size="sm" asChild>
					<a href={repoUrl} target="_blank" rel="noopener noreferrer">
						<HugeiconsIcon icon={GithubIcon} className="size-4" />
						View on GitHub
					</a>
				</Button>
			</div>

			<div className="bg-muted/40 flex items-center gap-4 rounded-md border p-4">
				<Image
					src="/logo.svg"
					alt="Neo Technologies logo"
					width={40}
					height={40}
					className="size-10 shrink-0 invert dark:invert-0"
				/>
				<p className="text-muted-foreground text-sm">
					NeoCut is a product by Neo Technologies and is under the NeoKit line
					of products, provided for free under the MIT license for all.
				</p>
			</div>
		</div>
	);
}

function InfoGrid({ rows }: { rows: Array<[string, React.ReactNode]> }) {
	return (
		<dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="min-w-0 break-words">{value}</dd>
				</div>
			))}
		</dl>
	);
}

function CommitCard({
	state,
	sha,
}: {
	state: CommitState | null;
	sha: string;
}) {
	if (!sha) {
		return (
			<p className="text-muted-foreground text-xs">
				No commit information was recorded for this build.
			</p>
		);
	}
	if (!state || state.status === "loading") {
		return <p className="text-muted-foreground text-xs">Loading commit details…</p>;
	}
	if (state.status === "error") {
		return (
			<p className="text-muted-foreground text-xs">
				Couldn&apos;t load commit details: {state.message}
			</p>
		);
	}

	const [title, ...rest] = state.commit.message.split("\n");
	const body = rest.join("\n").trim();
	const isLatest = state.latestSha === null ? null : state.latestSha === sha;

	return (
		<div className="flex flex-col gap-2 rounded-md border p-3">
			<a
				href={state.commit.url}
				target="_blank"
				rel="noopener noreferrer"
				className="text-sm font-medium hover:underline"
			>
				{title}
			</a>
			{body && (
				<p className="text-muted-foreground text-xs whitespace-pre-line">
					{body}
				</p>
			)}
			<span className="text-muted-foreground text-xs">
				{state.commit.author} · {formatDate(state.commit.date)}
			</span>
			{isLatest !== null && (
				<span
					className={
						isLatest ? "text-xs text-emerald-600 dark:text-emerald-400" : "text-xs text-amber-600 dark:text-amber-400"
					}
				>
					{isLatest
						? `Up to date with ${BUILD_INFO.branch}.`
						: `Newer commits are on ${BUILD_INFO.branch}.`}
				</span>
			)}
		</div>
	);
}
