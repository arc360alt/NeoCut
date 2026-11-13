"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Image01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor } from "@/editor/use-editor";
import { useInfiniteScroll } from "@/hooks/use-infinite-scroll";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { importStockItem } from "../import";
import type { ImportProgress } from "@/media/download";
import { ImportProgressIndicator } from "@/media/components/import-progress";
import type { StockMediaItem, StockSearchResponse } from "../types";

type StockKind = "videos" | "photos";

const SEARCH_DEBOUNCE_MS = 400;
const PAGE_SIZE = 24;

interface Results {
	key: string;
	items: StockMediaItem[];
	page: number;
	hasMore: boolean;
	isLoading: boolean;
	error: string | null;
}

function resultsKey({ kind, query }: { kind: StockKind; query: string }): string {
	return `${kind}|${query}`;
}

async function fetchStockPage({
	kind,
	query,
	page,
	signal,
}: {
	kind: StockKind;
	query: string;
	page: number;
	signal: AbortSignal;
}): Promise<StockSearchResponse> {
	const params = new URLSearchParams({
		type: kind,
		page: String(page),
		per_page: String(PAGE_SIZE),
	});
	if (query) params.set("q", query);
	const response = await fetch(`/api/stock/search?${params}`, { signal });
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(
			errorMessage({ body }) || `Search failed (${response.status})`,
		);
	}
	if (!isStockSearchResponse(body)) {
		throw new Error("Unexpected response from the stock search");
	}
	return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStockSearchResponse(value: unknown): value is StockSearchResponse {
	return (
		isRecord(value) &&
		Array.isArray(value.items) &&
		typeof value.page === "number" &&
		typeof value.hasMore === "boolean"
	);
}

function errorMessage({ body }: { body: unknown }): string {
	if (!isRecord(body)) return "";
	return [body.error, body.message]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join(". ");
}

function formatDuration(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
}

export function StockView() {
	const [kind, setKind] = useState<StockKind>("videos");
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<Results | null>(null);
	const key = resultsKey({ kind, query });

	useEffect(() => {
		const timer = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [input]);

	const loadPage = useCallback(
		({ page, signal }: { page: number; signal: AbortSignal }) => {
			setResults((previous) =>
				previous && previous.key === key
					? { ...previous, isLoading: true, error: null }
					: { key, items: [], page: 0, hasMore: true, isLoading: true, error: null },
			);
			fetchStockPage({ kind, query, page, signal })
				.then((data) =>
					setResults((previous) => {
						const items =
							previous && previous.key === key && page > 1
								? [...previous.items, ...data.items]
								: data.items;
						return {
							key,
							items,
							page: data.page,
							hasMore: data.hasMore,
							isLoading: false,
							error: null,
						};
					}),
				)
				.catch((error: unknown) => {
					if (signal.aborted) return;
					setResults((previous) => ({
						key,
						items: previous?.key === key ? previous.items : [],
						page: previous?.key === key ? previous.page : 0,
						hasMore: false,
						isLoading: false,
						error: error instanceof Error ? error.message : "Search failed",
					}));
				});
		},
		[kind, query, key],
	);

	// First page whenever the search or the kind changes.
	useEffect(() => {
		const controller = new AbortController();
		const timer = setTimeout(() => loadPage({ page: 1, signal: controller.signal }), 0);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [loadPage]);

	const current = results?.key === key ? results : null;
	const { scrollAreaRef, handleScroll } = useInfiniteScroll({
		onLoadMore: () => {
			if (!current) return;
			loadPage({ page: current.page + 1, signal: new AbortController().signal });
		},
		hasMore: current?.hasMore ?? false,
		isLoading: current?.isLoading ?? true,
	});

	return (
		<PanelView
			title="Stock"
			scrollRef={scrollAreaRef}
			onScroll={handleScroll}
			actions={
				<div className="bg-accent flex rounded-md p-0.5">
					{(["videos", "photos"] as const).map((option) => (
						<Button
							key={option}
							variant={kind === option ? "secondary" : "text"}
							size="sm"
							className="h-6 gap-1 px-2 text-xs"
							aria-pressed={kind === option}
							onClick={() => setKind(option)}
						>
							<HugeiconsIcon
								icon={option === "videos" ? Video01Icon : Image01Icon}
								className="size-3.5"
							/>
							{option === "videos" ? "Videos" : "Photos"}
						</Button>
					))}
				</div>
			}
		>
			<div className="flex flex-col gap-3 pb-3">
				<Input
					placeholder={`Search Pexels ${kind}`}
					value={input}
					onChange={({ currentTarget }) => setInput(currentTarget.value)}
					showClearIcon
					onClear={() => setInput("")}
				/>

				{current?.error ? (
					<p className="text-destructive text-sm">{current.error}</p>
				) : null}

				<div
					className="grid gap-2"
					style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}
				>
					{current?.items.map((item) => (
						<StockItem key={item.id} item={item} />
					))}
				</div>

				{current?.isLoading && (
					<p className="text-muted-foreground py-2 text-center text-sm">Loading…</p>
				)}
				{current && !current.isLoading && !current.error && current.items.length === 0 && (
					<p className="text-muted-foreground text-sm">No results for “{query}”.</p>
				)}

				<p className="text-muted-foreground text-xs">
					{kind === "videos" ? "Videos" : "Photos"} provided by{" "}
					<a
						href="https://www.pexels.com"
						target="_blank"
						rel="noreferrer"
						className="underline"
					>
						Pexels
					</a>
					. Free to use; crediting the creator is appreciated.
				</p>
			</div>
		</PanelView>
	);
}

function StockItem({ item }: { item: StockMediaItem }) {
	const editor = useEditor();
	const [isHovered, setIsHovered] = useState(false);
	const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);

	const addToTimeline = async ({ currentTime }: { currentTime: MediaTime }) => {
		if (importProgress !== null) return;
		setImportProgress({ stage: "downloading", fraction: null });
		try {
			const asset = await importStockItem({
				editor,
				item,
				onProgress: (progress) => setImportProgress(progress),
			});
			editor.timeline.insertElement({
				element: buildElementFromMedia({
					mediaId: asset.id,
					mediaType: asset.type,
					name: asset.name,
					duration:
						asset.duration != null
							? mediaTimeFromSeconds({ seconds: asset.duration })
							: DEFAULT_NEW_ELEMENT_DURATION,
					startTime: currentTime,
				}),
				placement: { mode: "auto" },
			});
		} catch (error) {
			console.error("Stock import failed:", error);
			toast.error("Couldn't add this item", {
				description: error instanceof Error ? error.message : undefined,
			});
		} finally {
			setImportProgress(null);
		}
	};

	const preview = (
		<div
			className="relative size-full"
			style={{ backgroundColor: item.color ?? undefined }}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			title={`${item.title} — ${item.author} on Pexels`}
		>
			{isHovered && item.previewVideoUrl ? (
				<video
					src={item.previewVideoUrl}
					poster={item.thumbnailUrl}
					className="size-full object-cover"
					autoPlay
					muted
					loop
					playsInline
				/>
			) : (
				// eslint-disable-next-line @next/next/no-img-element -- remote Pexels thumbnails are already sized
				<img
					src={item.thumbnailUrl}
					alt={item.title}
					className="size-full object-cover"
					loading="lazy"
					draggable={false}
				/>
			)}
			{item.duration !== null && (
				<span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[0.65rem] text-white tabular-nums">
					{formatDuration(item.duration)}
				</span>
			)}
			{importProgress !== null && (
				<div className="absolute inset-0 flex items-center justify-center bg-black/65 px-3 text-white">
					<ImportProgressIndicator
						progress={importProgress}
						className="items-center text-center"
						barClassName="bg-white/30 [&>div]:bg-white"
					/>
				</div>
			)}
		</div>
	);

	return (
		<DraggableItem
			name={item.author}
			preview={preview}
			dragData={{
				id: item.id,
				type: "media",
				mediaType: item.type,
				name: item.title,
			}}
			isDraggable={false}
			onAddToTimeline={addToTimeline}
			aspectRatio={16 / 9}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
