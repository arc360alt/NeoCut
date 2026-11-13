import type { MediaAsset, MediaType } from "@/media/types";

export const SUPPORTS_AUDIO: readonly MediaType[] = ["audio", "video"];

export function mediaSupportsAudio({
	media,
}: {
	media: MediaAsset | null | undefined;
}): boolean {
	if (!media) return false;
	return SUPPORTS_AUDIO.includes(media.type);
}

/**
 * Used when the browser reports no specific type for a file, which some do
 * for formats like .mov or .mkv (especially sandboxed browsers on Linux).
 */
const EXTENSION_MEDIA_TYPES: Record<string, MediaType> = {
	mp4: "video",
	m4v: "video",
	mov: "video",
	qt: "video",
	mkv: "video",
	webm: "video",
	avi: "video",
	"3gp": "video",
	mts: "video",
	m2ts: "video",
	mp3: "audio",
	wav: "audio",
	m4a: "audio",
	aac: "audio",
	ogg: "audio",
	oga: "audio",
	opus: "audio",
	flac: "audio",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	avif: "image",
	bmp: "image",
	svg: "image",
};

export const getMediaTypeFromFile = ({
	file,
}: {
	file: File;
}): MediaType | null => {
	const { type } = file;

	if (type.startsWith("image/")) {
		return "image";
	}
	if (type.startsWith("video/")) {
		return "video";
	}
	if (type.startsWith("audio/")) {
		return "audio";
	}

	const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
	return EXTENSION_MEDIA_TYPES[extension] ?? null;
};
