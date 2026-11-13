import type { LanguageCode } from "./languages";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
	/** Nothing but sound tags ([Music], ♪…) was heard; they were hidden. */
	onlySoundTags?: boolean;
}

export interface TranscriptionOptions {
	/**
	 * "hide": make the model write out sung words instead of tags like
	 * [Music] or *Outro*, and drop any tags left. "keep": caption them.
	 */
	soundTags: "hide" | "keep";
	/** Drop lines Whisper invents over music ("Thanks for watching!"). */
	removeFiller: boolean;
}

export const DEFAULT_TRANSCRIPTION_OPTIONS: TranscriptionOptions = {
	soundTags: "hide",
	removeFiller: true,
};

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
}
