import { describe, expect, test } from "bun:test";
import { StreamingPeakLimiter } from "../audio-mastering";

describe("StreamingPeakLimiter", () => {
	test("leaves audio under the headroom untouched", () => {
		const limiter = new StreamingPeakLimiter({ sampleRate: 48000 });
		const left = Float32Array.from({ length: 1000 }, (_, i) => 0.5 * Math.sin(i / 10));
		const original = left.slice();
		limiter.process({ channels: [left, left.slice()] });
		expect(Array.from(left)).toEqual(Array.from(original));
	});

	test("keeps loud peaks at or under the headroom across windows", () => {
		const limiter = new StreamingPeakLimiter({ sampleRate: 48000 });
		let maxPeak = 0;
		for (let window = 0; window < 5; window++) {
			const data = Float32Array.from({ length: 4800 }, (_, i) => 1.8 * Math.sin((window * 4800 + i) / 7));
			limiter.process({ channels: [data] });
			for (const value of data) maxPeak = Math.max(maxPeak, Math.abs(value));
		}
		expect(maxPeak).toBeLessThanOrEqual(0.98 + 1e-6);
		expect(maxPeak).toBeGreaterThan(0.5);
	});

	test("recovers to unity gain after a loud burst", () => {
		const limiter = new StreamingPeakLimiter({ sampleRate: 48000 });
		limiter.process({ channels: [new Float32Array(100).fill(2)] });
		// 2 seconds of quiet audio is far longer than the 120ms release.
		limiter.process({ channels: [new Float32Array(96000).fill(0)] });
		const quiet = new Float32Array(10).fill(0.3);
		limiter.process({ channels: [quiet] });
		expect(quiet[9]).toBeCloseTo(0.3, 5);
	});
});
