import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";
import { execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Facts about this build, shown in the editor's Settings → About tab. */
function getBuildInfo() {
	const run = (command: string) => {
		try {
			return execSync(command, { stdio: ["ignore", "pipe", "ignore"] })
				.toString()
				.trim();
		} catch {
			return "";
		}
	};

	// Vercel builds have no .git directory, but expose the commit as env vars.
	const commitSha =
		process.env.VERCEL_GIT_COMMIT_SHA || run("git rev-parse HEAD");
	const branch =
		process.env.VERCEL_GIT_COMMIT_REF || run("git rev-parse --abbrev-ref HEAD");

	// "local" when opencut-wasm resolves into rust/wasm/pkg (setup-wasm.sh or
	// scripts/vercel-install.sh), "npm" when it's the published package.
	let wasmSource = "unknown";
	let wasmVersion = "";
	try {
		const require = createRequire(path.join(process.cwd(), "package.json"));
		const manifestPath = require.resolve("opencut-wasm/package.json");
		const packageDir = path.dirname(manifestPath);
		const isLinked = realpathSync(packageDir).includes(
			path.join("rust", "wasm", "pkg"),
		);
		const isCopied = existsSync(path.join(packageDir, ".local-build"));
		wasmSource = isLinked || isCopied ? "local" : "npm";
		wasmVersion = (require(manifestPath) as { version?: string }).version ?? "";
	} catch {}

	return {
		NEXT_PUBLIC_BUILD_COMMIT_SHA: commitSha,
		NEXT_PUBLIC_BUILD_BRANCH: branch,
		NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
		NEXT_PUBLIC_WASM_SOURCE: wasmSource,
		NEXT_PUBLIC_WASM_VERSION: wasmVersion,
	};
}

const nextConfig: NextConfig = {
	env: getBuildInfo(),
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "standalone",
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

export default withContentCollections(withBotId(nextConfig));
