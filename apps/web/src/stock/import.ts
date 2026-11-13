import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset } from "@/media/types";
import { downloadWithProgress, type ImportProgress } from "@/media/download";
import type { StockMediaItem } from "./types";

function stockFileName({ item }: { item: StockMediaItem }): string {
	return `pexels-${item.id}.${item.type === "video" ? "mp4" : "jpg"}`;
}

/**
 * Brings a Pexels item into the project's media, downloading it the first
 * time. An item already imported into this project is reused.
 */
export async function importStockItem({
	editor,
	item,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	item: StockMediaItem;
	onProgress?: (progress: ImportProgress) => void;
	signal?: AbortSignal;
}): Promise<MediaAsset> {
	const name = stockFileName({ item });
	const existing = editor.media.getAssets().find((asset) => asset.name === name);
	if (existing) {
		return existing;
	}

	const blob = await downloadWithProgress({
		url: item.downloadUrl,
		onProgress: (fraction) => onProgress?.({ stage: "downloading", fraction }),
		signal,
	});
	// Reading the video and saving it into the project has no measurable
	// progress, but takes a moment for large files.
	onProgress?.({ stage: "importing" });
	const file = new File([blob], name, {
		type: blob.type || (item.type === "video" ? "video/mp4" : "image/jpeg"),
	});
	const [processed] = await processMediaAssets({ files: [file] });
	if (!processed) {
		throw new Error("Couldn't read the downloaded file");
	}
	const asset = await editor.media.addMediaAsset({
		projectId: editor.project.getActive().metadata.id,
		asset: processed,
	});
	if (!asset) {
		throw new Error("Couldn't save the file to this project");
	}
	return asset;
}
