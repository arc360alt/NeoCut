/**
 * Progress through adding remote media: a percentage while downloading
 * (null when the server doesn't report the size), then the import step.
 */
export type ImportProgress =
	| { stage: "downloading"; fraction: number | null }
	| { stage: "importing" };

/** Downloads a file, reporting how much has arrived. */
export async function downloadWithProgress({
	url,
	onProgress,
	signal,
}: {
	url: string;
	onProgress?: (fraction: number | null) => void;
	signal?: AbortSignal;
}): Promise<Blob> {
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed (${response.status})`);
	}
	const type = response.headers.get("content-type") ?? undefined;
	const total = Number(response.headers.get("content-length")) || 0;
	onProgress?.(total > 0 ? 0 : null);

	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		if (total > 0) onProgress?.(Math.min(1, received / total));
	}
	return new Blob(chunks, { type });
}
