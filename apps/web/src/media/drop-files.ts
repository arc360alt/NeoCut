import { toast } from "sonner";

/**
 * Whether a drag carries something from outside the page that is meant to be
 * a file. Sandboxed browsers (Flatpak, Snap) sometimes describe a file
 * dragged from the file manager only as a link to it.
 */
export function isExternalFileDrag({
	dataTransfer,
}: {
	dataTransfer: DataTransfer;
}): boolean {
	const { types } = dataTransfer;
	return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * The files a drop delivered. When the drop looked like files but the
 * browser handed over none, says so instead of doing nothing.
 */
export function readDroppedFiles({
	dataTransfer,
}: {
	dataTransfer: DataTransfer;
}): File[] {
	const files = Array.from(dataTransfer.files ?? []);
	if (files.length === 0 && isExternalFileDrag({ dataTransfer })) {
		toast.error("Couldn't read the dropped file", {
			description:
				"The browser didn't give the page access to it. This happens with sandboxed browsers (Flatpak or Snap) when dragging from the file manager. Use the Import button instead.",
		});
	}
	return files;
}
