/** H.264 levels: max macroblocks per second and per frame (ITU-T H.264 Table A-1). */
const AVC_LEVELS: ReadonlyArray<{ level: number; maxMbps: number; maxFs: number }> = [
	{ level: 30, maxMbps: 40_500, maxFs: 1_620 },
	{ level: 31, maxMbps: 108_000, maxFs: 3_600 },
	{ level: 32, maxMbps: 216_000, maxFs: 5_120 },
	{ level: 40, maxMbps: 245_760, maxFs: 8_192 },
	{ level: 42, maxMbps: 522_240, maxFs: 8_704 },
	{ level: 50, maxMbps: 589_824, maxFs: 22_080 },
	{ level: 51, maxMbps: 983_040, maxFs: 36_864 },
	{ level: 52, maxMbps: 2_073_600, maxFs: 36_864 },
	{ level: 60, maxMbps: 4_177_920, maxFs: 139_264 },
];

/** The lowest H.264 level that allows this frame size at this rate. */
export function avcLevelFor({
	width,
	height,
	framerate,
}: {
	width: number;
	height: number;
	framerate: number;
}): number {
	const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
	const mbps = frameMbs * framerate;
	const fit = AVC_LEVELS.find((entry) => frameMbs <= entry.maxFs && mbps <= entry.maxMbps);
	return (fit ?? AVC_LEVELS[AVC_LEVELS.length - 1]).level;
}

/**
 * Encoder settings for every H.264 encode (exports, GIF conversion), chosen
 * so phones and upload sites accept the file.
 *
 * - Constrained Baseline profile: no B-frames. Firefox's encoder otherwise
 *   emits B-frames, and phone transcoders (e.g. Google Messages' resize)
 *   fail on some of those files; phones' own recordings have none.
 * - A level that actually covers the size and frame rate. The encoder's
 *   default could be too low (720×1324 at 60 fps labelled level 3.2, which
 *   needs 4.0), and phone decoders refuse such streams.
 * - Annex B output: Firefox (on Linux at least) hands out a broken decoder
 *   setup record, with the first byte of its SPS and PPS doubled, so strict
 *   players that read only that record (like Discord's) never start
 *   playback. With Annex B, mediabunny builds the record itself from the
 *   intact parameter sets in the stream.
 */
export function applyAvcEncoderConfig(config: VideoEncoderConfig): void {
	if (!config.codec.startsWith("avc1") && !config.codec.startsWith("avc3")) {
		return;
	}
	const level = avcLevelFor({
		width: config.width,
		height: config.height,
		framerate: config.framerate ?? 30,
	});
	config.codec = `avc1.42E0${level.toString(16).padStart(2, "0")}`;
	config.avc = { format: "annexb" };
}
