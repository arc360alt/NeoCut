import {
	CustomVideoDecoder,
	type EncodedPacket,
	VideoSample,
	registerDecoder,
} from "mediabunny";

const STORAGE_KEY = "opencut:software-video-decoding";
/** Decodes queued in the browser's decoder before waiting for one to finish. */
const MAX_DECODE_QUEUE = 4;

let useSoftwareDecoding = readStoredPreference();
let isRegistered = false;

function readStoredPreference(): boolean {
	try {
		return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * The browser's decoder, asked to decode on the CPU. Registered with
 * mediabunny and only picked once hardware decoding has failed.
 */
class SoftwareVideoDecoder extends CustomVideoDecoder {
	private decoder: VideoDecoder | null = null;
	private error: unknown = null;

	static override supports(): boolean {
		return useSoftwareDecoding && typeof VideoDecoder !== "undefined";
	}

	override init(): void {
		this.decoder = new VideoDecoder({
			output: (frame) => this.onSample(new VideoSample(frame)),
			error: (error) => {
				this.error = error;
			},
		});
		this.decoder.configure({
			...this.config,
			hardwareAcceleration: "prefer-software",
		});
	}

	override async decode(packet: EncodedPacket): Promise<void> {
		const decoder = this.requireDecoder();
		decoder.decode(packet.toEncodedVideoChunk());
		while (decoder.decodeQueueSize > MAX_DECODE_QUEUE && !this.error) {
			await new Promise((resolve) =>
				decoder.addEventListener("dequeue", resolve, { once: true }),
			);
		}
		this.throwIfFailed();
	}

	override async flush(): Promise<void> {
		await this.requireDecoder().flush();
		this.throwIfFailed();
	}

	override close(): void {
		if (this.decoder && this.decoder.state !== "closed") {
			this.decoder.close();
		}
		this.decoder = null;
	}

	private requireDecoder(): VideoDecoder {
		this.throwIfFailed();
		if (!this.decoder) {
			throw new Error("Software video decoder is not initialized");
		}
		return this.decoder;
	}

	private throwIfFailed(): void {
		if (this.error) {
			throw this.error;
		}
	}
}

/** Registers the software fallback with mediabunny; call before decoding. */
export function registerVideoDecoding(): void {
	if (isRegistered) return;
	isRegistered = true;
	registerDecoder(SoftwareVideoDecoder);
}

export function isSoftwareVideoDecodingEnabled(): boolean {
	return useSoftwareDecoding;
}

/** Turns software decoding on or off for decoders created from now on. */
export function setSoftwareVideoDecoding({ enabled }: { enabled: boolean }): void {
	useSoftwareDecoding = enabled;
	try {
		if (enabled) {
			globalThis.localStorage?.setItem(STORAGE_KEY, "1");
		} else {
			globalThis.localStorage?.removeItem(STORAGE_KEY);
		}
	} catch {
		// Not remembered across visits.
	}
}

/**
 * Switches every decoder created from now on to software decoding, and
 * remembers that for later visits. Some GPU drivers (e.g. VA-API on Linux)
 * accept a video but then fail on its frames; the CPU decodes it fine.
 */
function enableSoftwareVideoDecoding(): void {
	if (useSoftwareDecoding) return;
	useSoftwareDecoding = true;
	console.warn(
		"Hardware video decoding failed; using software decoding from now on.",
	);
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, "1");
	} catch {
		// Not remembered; the next visit falls back again on its first failure.
	}
}

/**
 * Runs a decode, and if it fails while hardware decoding is in use, switches
 * to software decoding and runs it once more.
 */
export async function withDecodeFallback<T>({
	run,
	beforeRetry,
}: {
	run: () => Promise<T>;
	/** Discards decoders the failed attempt left open. */
	beforeRetry?: () => Promise<void>;
}): Promise<T> {
	registerVideoDecoding();
	if (useSoftwareDecoding) {
		return run();
	}
	try {
		return await run();
	} catch (error) {
		console.warn("Video decoding failed, retrying in software:", error);
		enableSoftwareVideoDecoding();
		await beforeRetry?.();
		return run();
	}
}
