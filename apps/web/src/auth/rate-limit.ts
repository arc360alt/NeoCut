import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { webEnv } from "@/env/web";

const redis = new Redis({
	url: webEnv.UPSTASH_REDIS_REST_URL,
	token: webEnv.UPSTASH_REDIS_REST_TOKEN,
});

export const baseRateLimit = new Ratelimit({
	redis,
	limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 requests per minute
	analytics: true,
	prefix: "rate-limit",
});

const UNAVAILABLE_WARNING_INTERVAL_MS = 60_000;
let lastUnavailableWarningAt = 0;

/**
 * Applies the per-IP limit. When the limiter's Redis can't be reached (for
 * example the local serverless-redis-http container is stopped), requests
 * are let through with a warning: a broken limiter must not take the
 * features it protects down with it.
 */
export async function checkRateLimit({ request }: { request: Request }) {
	const ip = request.headers.get("x-forwarded-for") ?? "anonymous";
	try {
		const { success } = await baseRateLimit.limit(ip);
		return { success, limited: !success };
	} catch (error) {
		const now = Date.now();
		if (now - lastUnavailableWarningAt > UNAVAILABLE_WARNING_INTERVAL_MS) {
			lastUnavailableWarningAt = now;
			console.warn(
				"Rate limiter unavailable, allowing request. Is the Redis service running?",
				error instanceof Error ? error.message : error,
			);
		}
		return { success: true, limited: false };
	}
}
