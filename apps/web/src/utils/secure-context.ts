/**
 * Browsers only expose file storage (OPFS) and video decoding (WebCodecs) to
 * secure contexts: https pages and http://localhost. Opening the dev server
 * by a network address (e.g. http://192.168.x.x:3000) disables both.
 */
export function getInsecureContextInfo(): {
	currentOrigin: string;
	localhostUrl: string;
} | null {
	if (typeof window === "undefined" || window.isSecureContext) {
		return null;
	}
	const { protocol, port, pathname, search, hash, origin } = window.location;
	const portPart = port ? `:${port}` : "";
	return {
		currentOrigin: origin,
		localhostUrl: `${protocol}//localhost${portPart}${pathname}${search}${hash}`,
	};
}

export const INSECURE_CONTEXT_MESSAGE =
	"This address isn't a secure context, so the browser blocks file storage and video decoding. Open NeoCut at http://localhost instead.";
