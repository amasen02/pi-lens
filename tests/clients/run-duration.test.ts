import { describe, expect, it } from "vitest";
import {
	formatRunDurationMs,
	isMeasuredDuration,
	toMeasuredDurationMs,
} from "../../clients/run-duration.js";

// #1479: `TestResult.duration` uses 0 as the "never measured" sentinel. These
// pin the sentinel's meaning, because two surfaces (the turn-end log and
// `formatResult`) now read it from here.
describe("test duration reporting (#1479)", () => {
	it("renders a measured duration in ms", () => {
		expect(formatRunDurationMs(253)).toBe("253ms");
		expect(formatRunDurationMs(1)).toBe("1ms");
	});

	it("renders the unmeasured sentinel as words, never as 0ms", () => {
		expect(formatRunDurationMs(0)).toBe("unmeasured");
	});

	it("renders a garbled duration as unmeasured rather than a wrong number", () => {
		expect(formatRunDurationMs(-1)).toBe("unmeasured");
		expect(formatRunDurationMs(Number.NaN)).toBe("unmeasured");
		expect(formatRunDurationMs(Number.POSITIVE_INFINITY)).toBe("unmeasured");
		expect(formatRunDurationMs(null)).toBe("unmeasured");
		expect(formatRunDurationMs(undefined)).toBe("unmeasured");
	});

	it("rounds a fractional duration to whole milliseconds", () => {
		expect(formatRunDurationMs(40.6)).toBe("41ms");
		// Rounds, does not truncate: 40.6 is nearer 41ms.
		expect(toMeasuredDurationMs(40.6)).toBe(41);
		expect(toMeasuredDurationMs(40.4)).toBe(40);
	});

	it("collapses every non-measurement to the 0 sentinel", () => {
		expect(toMeasuredDurationMs(-7)).toBe(0);
		expect(toMeasuredDurationMs(Number.NaN)).toBe(0);
		expect(toMeasuredDurationMs(Number.POSITIVE_INFINITY)).toBe(0);
		expect(toMeasuredDurationMs(0)).toBe(0);
	});

	it("agrees with the predicate the formatters branch on", () => {
		expect(isMeasuredDuration(0)).toBe(false);
		expect(isMeasuredDuration(0.5)).toBe(true);
		expect(isMeasuredDuration(Number.NaN)).toBe(false);
	});
});
