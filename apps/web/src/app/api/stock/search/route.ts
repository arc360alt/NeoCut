import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/auth/rate-limit";
import { webEnv } from "@/env/web";
import type { StockMediaItem, StockSearchResponse } from "@/stock/types";

const PEXELS_API = "https://api.pexels.com";
/** Downloads are scaled to this width; enough for video and far smaller than originals. */
const PHOTO_DOWNLOAD_WIDTH = 1920;
const MAX_VIDEO_DOWNLOAD_HEIGHT = 1080;

const searchParamsSchema = z.object({
	type: z.enum(["photos", "videos"]).default("videos"),
	q: z.string().trim().max(200).optional(),
	page: z.coerce.number().int().min(1).max(500).default(1),
	per_page: z.coerce.number().int().min(1).max(80).default(24),
});

const photoSchema = z.object({
	id: z.number(),
	width: z.number(),
	height: z.number(),
	url: z.string(),
	alt: z.string().nullish(),
	avg_color: z.string().nullish(),
	photographer: z.string(),
	photographer_url: z.string(),
	src: z.object({ original: z.string(), medium: z.string(), large: z.string() }),
});

const videoFileSchema = z.object({
	quality: z.string().nullish(),
	file_type: z.string(),
	width: z.number().nullish(),
	height: z.number().nullish(),
	link: z.string(),
});

const videoSchema = z.object({
	id: z.number(),
	width: z.number(),
	height: z.number(),
	url: z.string(),
	image: z.string(),
	duration: z.number(),
	user: z.object({ name: z.string(), url: z.string() }),
	video_files: z.array(videoFileSchema),
});

const photosResponseSchema = z.object({
	page: z.number(),
	photos: z.array(photoSchema),
	next_page: z.string().nullish(),
});

const videosResponseSchema = z.object({
	page: z.number(),
	videos: z.array(videoSchema),
	next_page: z.string().nullish(),
});

function withSearchParams({
	url,
	params,
}: {
	url: string;
	params: Record<string, string>;
}): string {
	const parsed = new URL(url);
	for (const [key, value] of Object.entries(params)) {
		parsed.searchParams.set(key, value);
	}
	return parsed.toString();
}

/**
 * The best MP4 at or under 1080p (by the short side, so portrait clips count
 * too), keeping imports reasonably sized.
 */
function pickVideoFile({
	files,
}: {
	files: z.infer<typeof videoFileSchema>[];
}): { link: string; width: number; height: number } | null {
	const mp4s = files.filter((file) => file.file_type === "video/mp4" && file.width && file.height);
	const fitting = mp4s.filter(
		(file) => Math.min(file.width ?? 0, file.height ?? 0) <= MAX_VIDEO_DOWNLOAD_HEIGHT,
	);
	const pool = fitting.length > 0 ? fitting : mp4s;
	const best = pool.sort((a, b) =>
		fitting.length > 0
			? (b.width ?? 0) - (a.width ?? 0)
			: (a.width ?? 0) - (b.width ?? 0),
	)[0];
	return best ? { link: best.link, width: best.width ?? 0, height: best.height ?? 0 } : null;
}

/** The smallest MP4, for hover previews. */
function pickPreviewFile({
	files,
}: {
	files: z.infer<typeof videoFileSchema>[];
}): string | null {
	const smallest = files
		.filter((file) => file.file_type === "video/mp4" && file.width)
		.sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0];
	return smallest?.link ?? null;
}

export async function GET(request: NextRequest) {
	const apiKey = webEnv.PEXELS_API_KEY;
	if (!apiKey) {
		return NextResponse.json(
			{
				error: "Stock media isn't configured",
				message: "Add PEXELS_API_KEY to apps/web/.env.local and restart the dev server.",
			},
			{ status: 503 },
		);
	}

	try {
		const { limited } = await checkRateLimit({ request });
		if (limited) {
			return NextResponse.json({ error: "Too many requests" }, { status: 429 });
		}

		const { searchParams } = new URL(request.url);
		const parsed = searchParamsSchema.safeParse({
			type: searchParams.get("type") || undefined,
			q: searchParams.get("q") || undefined,
			page: searchParams.get("page") || undefined,
			per_page: searchParams.get("per_page") || undefined,
		});
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid parameters", details: parsed.error.flatten().fieldErrors },
				{ status: 400 },
			);
		}

		const { type, q: query, page, per_page: perPage } = parsed.data;
		const endpoint =
			type === "photos"
				? query
					? "/v1/search"
					: "/v1/curated"
				: query
					? "/videos/search"
					: "/videos/popular";
		const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
		if (query) params.set("query", query);

		const response = await fetch(`${PEXELS_API}${endpoint}?${params}`, {
			headers: { Authorization: apiKey },
			next: { revalidate: 300 },
		});
		if (!response.ok) {
			console.error("Pexels API error:", response.status, await response.text());
			return NextResponse.json(
				{
					error:
						response.status === 401
							? "Pexels rejected the API key"
							: "Failed to search Pexels",
				},
				{ status: response.status === 401 ? 502 : response.status },
			);
		}

		const raw: unknown = await response.json();
		let items: StockMediaItem[];
		let hasMore: boolean;

		if (type === "photos") {
			const data = photosResponseSchema.parse(raw);
			hasMore = !!data.next_page;
			items = data.photos.map((photo) => ({
				id: `photo-${photo.id}`,
				type: "image",
				width: photo.width,
				height: photo.height,
				thumbnailUrl: photo.src.medium,
				previewVideoUrl: null,
				downloadUrl: withSearchParams({
					url: photo.src.original,
					params: {
						auto: "compress",
						cs: "tinysrgb",
						w: String(Math.min(PHOTO_DOWNLOAD_WIDTH, photo.width)),
					},
				}),
				duration: null,
				title: photo.alt || `Photo by ${photo.photographer}`,
				author: photo.photographer,
				authorUrl: photo.photographer_url,
				pageUrl: photo.url,
				color: photo.avg_color ?? null,
			}));
		} else {
			const data = videosResponseSchema.parse(raw);
			hasMore = !!data.next_page;
			items = data.videos.flatMap((video): StockMediaItem[] => {
				const file = pickVideoFile({ files: video.video_files });
				if (!file) return [];
				return [
					{
						id: `video-${video.id}`,
						type: "video",
						width: file.width,
						height: file.height,
						thumbnailUrl: video.image,
						previewVideoUrl: pickPreviewFile({ files: video.video_files }),
						downloadUrl: file.link,
						duration: video.duration,
						title: `Video by ${video.user.name}`,
						author: video.user.name,
						authorUrl: video.user.url,
						pageUrl: video.url,
						color: null,
					},
				];
			});
		}

		const body: StockSearchResponse = { items, page, hasMore };
		return NextResponse.json(body);
	} catch (error) {
		console.error("Stock search failed:", error);
		return NextResponse.json({ error: "Internal server error" }, { status: 500 });
	}
}
