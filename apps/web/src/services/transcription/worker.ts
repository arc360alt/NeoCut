import {
	pipeline,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type { TranscriptionOptions, TranscriptionSegment } from "@/transcription/types";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/transcription/audio";

export type WorkerMessage =
	| { type: "init"; modelId: string }
	| {
			type: "transcribe";
			audio: Float32Array;
			language: string;
			options: TranscriptionOptions;
	  }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
			/** Only sound tags were heard, and they were hidden. */
			onlySoundTags?: boolean;
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
/** Tokens that start a non-speech tag; banned so sung words get written out. */
let nonSpeechTokenIds: number[][] = [];

/**
 * Whisper labels singing, instrumentals and noise with tags like "[Music]",
 * "(Outro)", "*music*" or "♪". The reference implementation suppresses
 * these tokens while decoding; transformers.js doesn't, so on songs the
 * model often writes the tag instead of the lyrics. Banning every token
 * that opens such a tag makes it transcribe the words.
 */
function findNonSpeechTokenIds({
	pipe,
}: {
	pipe: AutomaticSpeechRecognitionPipeline;
}): number[][] {
	const { tokenizer } = pipe;
	// Text tokens come first; special tokens (<|...|>) follow the last one.
	const endOfText = tokenizer.model.tokens_to_ids.get("<|endoftext|>") ?? 50257;
	const ids: number[][] = [];
	for (let id = 0; id < endOfText; id++) {
		const text = tokenizer.decode([id]).trimStart();
		if (/^[[(*{♪♫♬♩<]/u.test(text) || /[♪♫♬♩]/u.test(text)) {
			ids.push([id]);
		}
	}
	return ids;
}

/** Phrases Whisper invents over silence or instruments. */
const HALLUCINATED_LINES =
	/^(thank you\.?|thanks for watching!?|thank you for watching!?|please subscribe\.?|subtitles by .*|you)$/i;

const SOUND_TAG = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫♬♩]/gu;

function cleanSegmentText({
	text,
	options,
}: {
	text: string;
	options: TranscriptionOptions;
}): string {
	const withoutTags = options.soundTags === "hide" ? text.replace(SOUND_TAG, " ") : text;
	const cleaned = withoutTags.replace(/\s+/g, " ").trim();
	return options.removeFiller && HALLUCINATED_LINES.test(cleaned) ? "" : cleaned;
}

function hasSoundTag({ text }: { text: string }): boolean {
	return new RegExp(SOUND_TAG.source, "u").test(text);
}
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit({ modelId: message.modelId });
			break;
		case "transcribe":
			await handleTranscribe({
				audio: message.audio,
				language: message.language,
				options: message.options,
			});
			break;
		case "cancel":
			cancelled = true;
			self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
			break;
	}
};

async function handleInit({ modelId }: { modelId: string }) {
	lastReportedProgress = -1;
	fileBytes.clear();

	try {
		transcriber = (await pipeline("automatic-speech-recognition", modelId, {
			dtype: "q4",
			device: "auto",
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				// sum all bytes
				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}

				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);

				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;
		try {
			nonSpeechTokenIds = findNonSpeechTokenIds({ pipe: transcriber });
		} catch (error) {
			// Tags then just get removed afterwards instead of being prevented.
			console.warn("Couldn't find sound-tag tokens:", error);
			nonSpeechTokenIds = [];
		}

		self.postMessage({ type: "init-complete" } satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "Failed to load model",
		} satisfies WorkerResponse);
	}
}

async function handleTranscribe({
	audio,
	language,
	options,
}: {
	audio: Float32Array;
	language: string;
	options: TranscriptionOptions;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "Model not initialized",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	try {
		const hideTags = options.soundTags === "hide";
		let chunks = await runTranscription({
			pipe: transcriber,
			audio,
			language,
			banTags: hideTags,
		});
		if (cancelled) return;

		let segments = toSegments({ chunks, options });
		let onlySoundTags = false;
		// Banning tags can leave the model with nothing it's willing to write
		// (e.g. a purely instrumental track). Listen again with tags allowed,
		// so we can tell the user that only music/sounds were heard.
		if (hideTags && segments.length === 0 && nonSpeechTokenIds.length > 0) {
			chunks = await runTranscription({ pipe: transcriber, audio, language, banTags: false });
			if (cancelled) return;
			segments = toSegments({ chunks, options });
			onlySoundTags =
				segments.length === 0 && chunks.some((chunk) => hasSoundTag({ text: chunk.text }));
		}

		self.postMessage({
			type: "transcribe-complete",
			text: segments.map((segment) => segment.text).join(" "),
			segments,
			onlySoundTags,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}

type Chunk = { text: string; timestamp?: (number | null)[] };

async function runTranscription({
	pipe,
	audio,
	language,
	banTags,
}: {
	pipe: AutomaticSpeechRecognitionPipeline;
	audio: Float32Array;
	language: string;
	banTags: boolean;
}): Promise<Chunk[]> {
	const rawResult = await pipe(audio, {
		chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
		stride_length_s: DEFAULT_STRIDE_SECONDS,
		language: language === "auto" ? undefined : language,
		return_timestamps: true,
		...(banTags && nonSpeechTokenIds.length > 0 ? { bad_words_ids: nonSpeechTokenIds } : {}),
	});
	const result: AutomaticSpeechRecognitionOutput = Array.isArray(rawResult)
		? rawResult[0]
		: rawResult;
	return result.chunks ?? (result.text ? [{ text: result.text, timestamp: [0, null] }] : []);
}

function toSegments({
	chunks,
	options,
}: {
	chunks: Chunk[];
	options: TranscriptionOptions;
}): TranscriptionSegment[] {
	const segments: TranscriptionSegment[] = [];
	for (const chunk of chunks) {
		const text = cleanSegmentText({ text: chunk.text, options });
		if (!text || !chunk.timestamp || chunk.timestamp.length < 2) continue;
		const start = chunk.timestamp[0] ?? 0;
		segments.push({ text, start, end: chunk.timestamp[1] ?? start });
	}
	return segments;
}
