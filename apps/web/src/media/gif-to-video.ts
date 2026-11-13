import {
	BufferTarget,
	Mp4OutputFormat,
	Output,
	QUALITY_HIGH,
	VideoSample,
	VideoSampleSource,
	WebMOutputFormat,
} from "mediabunny";
import { applyAvcEncoderConfig } from "./avc-encoding";

/** A looping GIF is repeated until the video is at least this long. */
const MIN_LOOPED_SECONDS = 5;
/** Browsers show GIF frames shorter than this at 100 ms; so do we. */
const MIN_FRAME_SECONDS = 0.02;
const SHORT_FRAME_SECONDS = 0.1;
/** Frames checked for transparency (spread over the animation). */
const ALPHA_SAMPLE_FRAMES = 6;

interface GifSurvey {
	durations: number[];
	loops: boolean;
	width: number;
	height: number;
	hasAlpha: boolean;
}

export function isGifFile({ file }: { file: File }): boolean {
	return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

/**
 * Turns an animated GIF into a video so it plays on the timeline (images
 * only ever show one frame). Opaque GIFs become MP4; GIFs with transparent
 * pixels become WebM (VP9) with an alpha channel, so stickers stay
 * see-through. Returns null for a still GIF, or where the browser cannot
 * decode GIF frames.
 */
export async function convertAnimatedGif({
	file,
}: {
	file: File;
}): Promise<File | null> {
	if (typeof ImageDecoder === "undefined" || typeof VideoEncoder === "undefined") {
		return null;
	}
	if (!(await ImageDecoder.isTypeSupported("image/gif"))) {
		return null;
	}

	const data = await file.arrayBuffer();
	const survey = await surveyGif({ data });
	if (!survey) {
		return null;
	}
	return encodeGif({ data, survey, name: file.name.replace(/\.gif$/i, "") });
}

/**
 * Decodes each frame of the GIF once, in order, handing it to `onFrame`
 * and closing it right after. A new decoder per pass: Firefox's decoder
 * hands out the same frame object again for a repeated index, which is
 * unusable once closed. One frame is held at a time, whatever the length.
 */
async function forEachFrame({
	data,
	onFrame,
}: {
	data: ArrayBuffer;
	onFrame: (frame: VideoFrame, frameIndex: number) => Promise<boolean | void> | boolean | void;
}): Promise<{ frameCount: number; animated: boolean; loops: boolean }> {
	const decoder = new ImageDecoder({ data, type: "image/gif" });
	try {
		await decoder.tracks.ready;
		await decoder.completed;
		const track = decoder.tracks.selectedTrack;
		if (!track) {
			return { frameCount: 0, animated: false, loops: false };
		}
		for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
			const { image } = await decoder.decode({ frameIndex });
			try {
				// Returning false stops early.
				if ((await onFrame(image, frameIndex)) === false) break;
			} finally {
				image.close();
			}
		}
		return {
			frameCount: track.frameCount,
			animated: track.animated,
			loops: track.repetitionCount !== 0,
		};
	} finally {
		decoder.close();
	}
}

/** Frame timings, size and transparency, or null for a still GIF. */
async function surveyGif({ data }: { data: ArrayBuffer }): Promise<GifSurvey | null> {
	const durations: number[] = [];
	let width = 0;
	let height = 0;
	let hasAlpha = false;
	let context: OffscreenCanvasRenderingContext2D | null = null;
	let frameCount = 0;

	const decoder = new ImageDecoder({ data, type: "image/gif" });
	try {
		await decoder.tracks.ready;
		await decoder.completed;
		frameCount = decoder.tracks.selectedTrack?.frameCount ?? 0;
	} finally {
		decoder.close();
	}
	if (frameCount < 2) {
		return null;
	}
	const alphaStep = Math.max(1, Math.floor(frameCount / ALPHA_SAMPLE_FRAMES));

	const { animated, loops } = await forEachFrame({
		data,
		onFrame: (frame, frameIndex) => {
			const seconds = (frame.duration ?? 0) / 1e6;
			durations.push(seconds < MIN_FRAME_SECONDS ? SHORT_FRAME_SECONDS : seconds);

			if (frameIndex === 0) {
				// H.264 and VP9 want even dimensions.
				width = Math.max(2, frame.displayWidth - (frame.displayWidth % 2));
				height = Math.max(2, frame.displayHeight - (frame.displayHeight % 2));
				context = new OffscreenCanvas(width, height).getContext("2d", {
					willReadFrequently: true,
				});
			}
			if (!hasAlpha && context && frameIndex % alphaStep === 0) {
				hasAlpha = frameHasAlpha({ frame, context, width, height });
			}
		},
	});
	if (!animated) {
		return null;
	}
	return { durations, loops, width, height, hasAlpha };
}

async function encodeGif({
	data,
	survey,
	name,
}: {
	data: ArrayBuffer;
	survey: GifSurvey;
	name: string;
}): Promise<File> {
	const { durations, loops, width, height, hasAlpha } = survey;
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("Failed to get 2d context for GIF conversion");
	}

	const target = new BufferTarget();
	const output = new Output({
		format: hasAlpha ? new WebMOutputFormat() : new Mp4OutputFormat(),
		target,
	});
	const source = new VideoSampleSource({
		codec: hasAlpha ? "vp9" : "avc",
		bitrate: QUALITY_HIGH,
		alpha: hasAlpha ? "keep" : "discard",
		onEncoderConfig: applyAvcEncoderConfig,
	});
	output.addVideoTrack(source);
	await output.start();

	const cycleSeconds = durations.reduce((total, duration) => total + duration, 0);
	const cycles = loops ? Math.max(1, Math.ceil(MIN_LOOPED_SECONDS / cycleSeconds)) : 1;
	let timestamp = 0;
	for (let cycle = 0; cycle < cycles; cycle++) {
		await forEachFrame({
			data,
			onFrame: async (frame, frameIndex) => {
				const duration = durations[frameIndex] ?? SHORT_FRAME_SECONDS;
				context.clearRect(0, 0, width, height);
				context.drawImage(frame, 0, 0, width, height);
				const sample = new VideoSample(canvas, { timestamp, duration });
				try {
					await source.add(sample);
				} finally {
					sample.close();
				}
				timestamp += duration;
			},
		});
	}

	source.close();
	await output.finalize();
	if (!target.buffer) {
		throw new Error("GIF conversion produced no output");
	}
	const extension = hasAlpha ? "webm" : "mp4";
	return new File([target.buffer], `${name}.${extension}`, {
		type: hasAlpha ? "video/webm" : "video/mp4",
	});
}

/** Whether the frame has a pixel that isn't fully opaque. */
function frameHasAlpha({
	frame,
	context,
	width,
	height,
}: {
	frame: VideoFrame;
	context: OffscreenCanvasRenderingContext2D;
	width: number;
	height: number;
}): boolean {
	context.clearRect(0, 0, width, height);
	context.drawImage(frame, 0, 0, width, height);
	const { data } = context.getImageData(0, 0, width, height);
	for (let offset = 3; offset < data.length; offset += 4) {
		if (data[offset] < 255) {
			return true;
		}
	}
	return false;
}
