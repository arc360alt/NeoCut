export type StockMediaType = "image" | "video";

/** A Pexels photo or video, normalised by /api/stock/search. */
export interface StockMediaItem {
	id: string;
	type: StockMediaType;
	width: number;
	height: number;
	thumbnailUrl: string;
	/** Small MP4 for hover previews (videos only). */
	previewVideoUrl: string | null;
	/** The file that gets imported. */
	downloadUrl: string;
	/** Seconds (videos only). */
	duration: number | null;
	title: string;
	author: string;
	authorUrl: string;
	/** The item's page on Pexels. */
	pageUrl: string;
	color: string | null;
}

export interface StockSearchResponse {
	items: StockMediaItem[];
	page: number;
	hasMore: boolean;
}
