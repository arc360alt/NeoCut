/** Values injected at build time by next.config.ts (see getBuildInfo there). */
const branch = process.env.NEXT_PUBLIC_BUILD_BRANCH ?? "";
const wasmSource = process.env.NEXT_PUBLIC_WASM_SOURCE;

export const BUILD_INFO = {
	commitSha: process.env.NEXT_PUBLIC_BUILD_COMMIT_SHA ?? "",
	/** Empty when unknown, including a detached HEAD. */
	branch: branch === "HEAD" ? "" : branch,
	buildTime: process.env.NEXT_PUBLIC_BUILD_TIME ?? "",
	/** Whether opencut-wasm came from rust/wasm ("local") or npm. */
	wasmSource:
		wasmSource === "local" || wasmSource === "npm" ? wasmSource : "unknown",
	wasmVersion: process.env.NEXT_PUBLIC_WASM_VERSION ?? "",
};
