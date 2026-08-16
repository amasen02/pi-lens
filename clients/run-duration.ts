/**
 * #1479: one place decides whether a test run was actually timed.
 *
 * `TestResult.duration` carries two different facts in one number. A run that
 * took 40ms reports 40. A run with no suite timestamps, an `emptyResult`, or a
 * runner error also reports a number — 0 — and the turn-end log printed that
 * as `(0ms)`, which reads as a measurement of zero. A reader could not tell
 * "measured 0" from "never measured", which is the confusion #1452 was
 * reported for and the reason #1480 is otherwise unverifiable from the log.
 *
 * Every parser in `test-runner-client.ts` degrades to 0 when it cannot find an
 * elapsed time (see `jsonRunDurationMs` and `parsePhpunitOutput`, both #1452),
 * so 0 is the agreed sentinel for "unmeasured". This module is the only place
 * that spells out what that sentinel means, so the log line and the
 * agent-facing `formatResult` cannot drift apart.
 *
 * Kept in its own module rather than exported from `test-runner-client.ts`:
 * `runtime-turn.ts` needs it on the hot turn-end path, and the client is
 * deliberately loaded lazily (`bootstrap.ts` dynamic-imports it), so a value
 * import from there would drag the whole runner into startup.
 */

/** True only for a duration that represents a real measurement. */
export function isMeasuredDuration(
	duration: number | null | undefined,
): duration is number {
	return (
		typeof duration === "number" && Number.isFinite(duration) && duration > 0
	);
}

/**
 * Normalise a parsed elapsed time to the `TestResult.duration` contract.
 *
 * Negative, NaN, and non-finite inputs collapse to the unmeasured sentinel: a
 * garbled summary must degrade to "we did not measure this", never to a wrong
 * number.
 */
export function toMeasuredDurationMs(duration: number): number {
	return isMeasuredDuration(duration) ? Math.round(duration) : 0;
}

/** Render a duration for a log line: `123ms`, or `unmeasured` when absent. */
export function formatRunDurationMs(
	duration: number | null | undefined,
): string {
	return isMeasuredDuration(duration) ? `${Math.round(duration)}ms` : "unmeasured";
}
