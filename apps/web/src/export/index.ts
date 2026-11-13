import type { FrameRate } from "opencut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
	/**
	 * Leave the background transparent (no project background, alpha kept).
	 * WebM only: H.264 MP4 has no alpha channel.
	 */
	transparentBackground?: boolean;
}

export interface ExportResult {
	success: boolean;
	/** The exported video; usually backed by a file on disk, not memory. */
	file?: Blob;
	error?: string;
	cancelled?: boolean;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

/**
 * Large files keep being read after the click returns, so the URL must stay
 * alive for a while (some browsers fail the download if it's revoked early).
 */
const DOWNLOAD_URL_LIFETIME_MS = 5 * 60 * 1000;

export function downloadBlob({
	blob,
	filename,
	mimeType,
}: {
	blob: Blob;
	filename: string;
	mimeType: string;
}): void {
	const typedBlob = blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType);
	const url = URL.createObjectURL(typedBlob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}
