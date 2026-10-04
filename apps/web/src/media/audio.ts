import type {
	AudioElement,
	VideoElement,
	LibraryAudioElement,
	RetimeConfig,
	SceneTracks,
} from "@/timeline";
import { shouldMaintainPitch } from "@/retime/rate";
import type { MediaAsset } from "@/media/types";
import { applyAudioMasteringToBuffer } from "@/media/audio-mastering";
import type { AudioCapableElement } from "@/timeline/audio-state";
import {
	hasAnimatedVolume,
	isElementMuted,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { doesElementHaveEnabledAudio } from "@/timeline/audio-separation";
import { canElementHaveAudio, hasMediaId } from "@/timeline/element-utils";
import { canTrackHaveAudio } from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import { decodeFileAudio } from "./audio-decode";
import { streamMixClip } from "./audio-stream-mix";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	computeRmsBuckets,
	type SampleBucket,
} from "@/media/waveform-summary";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

export interface CollectedAudioElement {
	timelineElement: AudioCapableElement;
	buffer: AudioBuffer;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
	sampleRate,
}: {
	audioBlob: Blob;
	sampleRate?: number;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext({ sampleRate });
	const arrayBuffer = await audioBlob.arrayBuffer();
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

	// mix down to mono
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const samples = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let channel = 0; channel < numChannels; channel++) {
			sum += audioBuffer.getChannelData(channel)[i];
		}
		samples[i] = sum / numChannels;
	}

	return { samples, sampleRate: audioBuffer.sampleRate };
}

export interface AudibleElementCandidate {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
}

export function collectAudibleCandidates({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): AudibleElementCandidate[] {
	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mediaMap = new Map(mediaAssets.map((a) => [a.id, a]));
	const candidates: AudibleElementCandidate[] = [];

	for (const track of allTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			candidates.push({ element, mediaAsset });
		}
	}

	return candidates;
}

export function timelineHasAudio({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): boolean {
	return collectAudibleCandidates({ tracks, mediaAssets }).some(
		({ element }) => !isElementMuted({ element }),
	);
}

async function resolveAudioBufferForElement({
	element,
	mediaMap,
	audioContext,
}: {
	element: AudioElement;
	mediaMap: Map<string, MediaAsset>;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
	try {
		if (element.sourceType === "upload") {
			const asset = mediaMap.get(element.mediaId);
			if (!asset) return null;
			return await resolveAudioBufferForAsset({ asset, audioContext });
		}

		if (element.buffer) return element.buffer;

		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return await audioContext.decodeAudioData(arrayBuffer.slice(0));
	} catch (error) {
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForAsset({
	asset,
	audioContext,
}: {
	asset: MediaAsset;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
	if (asset.type === "audio") {
		try {
			const arrayBuffer = await asset.file.arrayBuffer();
			return await audioContext.decodeAudioData(arrayBuffer);
		} catch (error) {
			console.warn("Failed to decode audio asset:", error);
			return null;
		}
	}

	try {
		return await decodeFileAudio({
			file: asset.file,
			audioContext,
			maxChannels: MAX_AUDIO_CHANNELS,
		});
	} catch (error) {
		console.warn("Failed to decode asset audio:", error);
		return null;
	}
}

interface AudioMixSource {
	timelineElement: AudioCapableElement;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	retime?: RetimeConfig;
}

export interface AudioClipSource {
	timelineElement: AudioCapableElement;
	id: string;
	sourceKey: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

const libraryAudioFiles = new Map<string, Promise<File>>();

/**
 * Downloads a sound from the library once per session; playback asks for it
 * every time play is pressed.
 */
function fetchLibraryAudioFile({
	element,
}: {
	element: LibraryAudioElement;
}): Promise<File> {
	const cached = libraryAudioFiles.get(element.sourceUrl);
	if (cached) {
		return cached;
	}

	const promise = (async () => {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}
		const blob = await response.blob();
		return new File([blob], `${element.name}.mp3`, { type: "audio/mpeg" });
	})();
	libraryAudioFiles.set(element.sourceUrl, promise);
	promise.catch(() => libraryAudioFiles.delete(element.sourceUrl));
	return promise;
}

async function fetchLibraryAudioSource({
	element,
	volume,
}: {
	element: LibraryAudioElement;
	volume: number;
}): Promise<AudioMixSource | null> {
	try {
		const file = await fetchLibraryAudioFile({ element });

		return {
			timelineElement: element,
			file,
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
	volume,
}: {
	element: LibraryAudioElement;
	muted: boolean;
	volume: number;
}): Promise<AudioClipSource | null> {
	try {
		const file = await fetchLibraryAudioFile({ element });

		return {
			timelineElement: element,
			id: element.id,
			sourceKey: element.id,
			file,
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume,
			muted,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	element,
	mediaAsset,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	volume: number;
}): AudioMixSource {
	return {
		timelineElement: element,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		retime: element.retime,
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	muted: boolean;
	volume: number;
}): AudioClipSource {
	return {
		timelineElement: element,
		id: element.id,
		sourceKey: mediaAsset.id,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		muted,
		retime: element.retime,
	};
}

export async function collectAudioMixSources({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<AudioMixSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of orderedTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (isElementMuted({ element })) continue;
			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;
			const volume = resolveEffectiveAudioGain({
				element,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				} else {
					pendingLibrarySources.push(
						fetchLibraryAudioSource({ element, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClips({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<AudioClipSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of orderedTracks) {
		const isTrackMuted = canTrackHaveAudio(track) && track.muted;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			const muted = isTrackMuted || isElementMuted({ element });
			const volume = resolveEffectiveAudioGain({
				element,
				trackMuted: isTrackMuted,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({ element, muted, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	audioContext?: AudioContext;
}): Promise<AudioBuffer | null> {
	const context = audioContext ?? createAudioContext({ sampleRate });
	const candidates = collectAudibleCandidates({ tracks, mediaAssets }).filter(
		({ element, mediaAsset }) =>
			!isElementMuted({ element }) &&
			(element.type !== "video" ||
				(mediaAsset !== null && mediaSupportsAudio({ media: mediaAsset }))),
	);
	if (candidates.length === 0) return null;

	const outputChannels = 2;
	const durationSeconds = duration / TICKS_PER_SECOND;
	const outputLength = Math.ceil(durationSeconds * sampleRate);
	const outputBuffer = context.createBuffer(
		outputChannels,
		outputLength,
		sampleRate,
	);
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	// Only the fallback path holds whole decoded sources; decode each once.
	const decodedSources = new Map<string, Promise<AudioBuffer | null>>();

	// One clip at a time: a long edit can have hundreds of clips cut from the
	// same file, and decoding them all at once exhausts memory.
	for (const { element, mediaAsset } of candidates) {
		const clip = {
			timelineElement: element,
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume: resolveEffectiveAudioGain({
				element,
				trackMuted: false,
				localTime: 0,
			}),
			muted: false,
			retime: element.retime,
		};
		const preservesPitch = shouldMaintainPitch({
			rate: element.retime?.rate ?? 1,
			maintainPitch: element.retime?.maintainPitch,
		});

		if (!preservesPitch) {
			const file = await getElementAudioFile({ element, mediaAsset }).catch(
				(error: unknown) => {
					console.warn("Failed to load clip audio:", error);
					return null;
				},
			);
			const mixed = file
				? await streamMixClip({ clip: { ...clip, file }, outputBuffer }).catch(
						(error: unknown) => {
							console.warn("Streaming audio mix failed:", error);
							return false;
						},
					)
				: false;
			if (mixed) continue;
		}

		const sourceKey =
			element.type === "audio" && element.sourceType === "library"
				? `library:${element.sourceUrl}`
				: `media:${mediaAsset?.id ?? element.id}`;
		let decoded = decodedSources.get(sourceKey);
		if (!decoded) {
			decoded =
				element.type === "audio"
					? resolveAudioBufferForElement({ element, mediaMap, audioContext: context })
					: mediaAsset
						? resolveAudioBufferForAsset({ asset: mediaAsset, audioContext: context })
						: Promise.resolve(null);
			decodedSources.set(sourceKey, decoded);
		}
		const buffer = await decoded;
		if (!buffer) continue;

		const collected: CollectedAudioElement = { ...clip, buffer };
		const renderedBuffer = preservesPitch
			? await renderRetimedBuffer({
					audioContext: context,
					sourceBuffer: buffer,
					trimStart: collected.trimStart,
					clipDuration: collected.duration,
					retime: collected.retime,
					maintainPitch: true,
				})
			: undefined;

		mixAudioChannels({
			element: collected,
			buffer: renderedBuffer ?? buffer,
			trimStart: renderedBuffer ? 0 : collected.trimStart,
			retime: renderedBuffer ? undefined : collected.retime,
			outputBuffer,
			outputLength,
			sampleRate,
		});
	}

	return await applyAudioMasteringToBuffer({ audioBuffer: outputBuffer });
}

/** The file holding a clip's audio: its media, or the downloaded library sound. */
async function getElementAudioFile({
	element,
	mediaAsset,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset | null;
}): Promise<Blob | null> {
	if (element.type === "audio" && element.sourceType === "library") {
		return fetchLibraryAudioFile({ element });
	}
	return mediaAsset?.file ?? null;
}

function collectPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): Float32Array {
	const channels = buffer.numberOfChannels;
	const peaks = new Float32Array(count);

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < count; i++) {
			const { bucketStart: start, bucketEnd: end } = getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex: i,
				bucketCount: count,
			});
			for (let j = start; j < end; j++) {
				const abs = Math.abs(data[j]);
				if (abs > peaks[i]) peaks[i] = abs;
			}
		}
	}

	return peaks;
}

export function extractPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return Array.from(
		collectPeakRange({
			buffer,
			count,
			startSample,
			endSample,
		}),
	);
}

export function getSampleBucketRange({
	startSample,
	endSample,
	bucketIndex,
	bucketCount,
}: {
	startSample: number;
	endSample: number;
	bucketIndex: number;
	bucketCount: number;
}): {
	bucketStart: number;
	bucketEnd: number;
} {
	const rangeLength = Math.max(0, endSample - startSample);
	const bucketStart =
		startSample + Math.floor((bucketIndex * rangeLength) / bucketCount);
	const bucketEnd =
		startSample + Math.floor(((bucketIndex + 1) * rangeLength) / bucketCount);
	return {
		bucketStart,
		bucketEnd: Math.max(bucketStart, bucketEnd),
	};
}

export function extractRmsBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	return computeRmsBuckets({ buffer, buckets });
}

/**
 * Computes per-bucket waveform amplitude using the maximum RMS over a short
 * analysis window inside each bucket.
 *
 * A naive mean-RMS over a whole bucket averages silence together with nearby
 * sound, which smears transitions (e.g. the onset of speech) across the
 * bucket and makes the waveform respond late. Taking the max over fixed
 * short windows (~20 ms) preserves the smooth, non-jittery RMS character
 * while making transitions land where they actually happen in the audio.
 *
 * Channels are combined per-window before taking the max, so the measure
 * reflects total energy regardless of stereo layout.
 */
export function extractRmsRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return extractRmsBuckets({
		buffer,
		buckets: Array.from({ length: count }, (_, bucketIndex) =>
			getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex,
				bucketCount: count,
			}),
		),
	});
}

function mixAudioChannels({
	element,
	buffer,
	trimStart,
	retime,
	outputBuffer,
	outputLength,
	sampleRate,
}: {
	element: CollectedAudioElement;
	buffer: AudioBuffer;
	trimStart: number;
	retime?: RetimeConfig;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
}): void {
	const { startTime, duration: elementDuration } = element;

	const outputStartSample = Math.floor(startTime * sampleRate);
	const renderedLength = Math.ceil(elementDuration * sampleRate);

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);

		for (let i = 0; i < renderedLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex >= outputLength) break;

			const clipTime = i / sampleRate;
			const sourceTime =
				trimStart + getSourceTimeAtClipTime({ clipTime, retime });
			const sourceIndex = sourceTime * buffer.sampleRate;
			if (sourceIndex >= sourceData.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(sourceData.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;
			const gain = hasAnimatedVolume({ element: element.timelineElement })
				? resolveEffectiveAudioGain({
						element: element.timelineElement,
						localTime: clipTime,
					})
				: element.volume;
			outputData[outputIndex] +=
				(sourceData[lowerIndex] * (1 - fraction) +
					sourceData[upperIndex] * fraction) *
				gain;
		}
	}
}
