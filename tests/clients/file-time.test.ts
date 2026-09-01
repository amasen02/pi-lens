import { describe, expect, it } from "vitest";
import { createFileTime } from "../../clients/file-time.js";

// #2402: partial-apply's pre-write rejection is the first FileTime.withLock
// caller whose fn can REJECT. The lock map's stored promise must never turn
// that into an unhandled rejection, and a waiter must still resume.
describe("FileTime.withLock rejection handling", () => {
	it("does not leak an unhandled rejection and still releases the lock", async () => {
		const fileTime = createFileTime("partial-apply-lock-test");
		let unhandled = false;
		const onUnhandled = (): void => {
			unhandled = true;
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(
				fileTime.withLock("/locked/file.ts", async () => {
					throw new Error("rejection inside the lock");
				}),
			).rejects.toThrow("rejection inside the lock");

			// The stored lock promise settles without crashing a waiter, and a
			// same-path waiter resumes only after the holder releases (both ran;
			// microtask ordering between the holder's own continuation and the
			// waiter's fn is not pinned).
			await new Promise<void>((resolve) => setImmediate(resolve));
			const waiterOrder: string[] = [];
			await Promise.all([
				fileTime
					.withLock("/locked/file.ts", async () => {
						waiterOrder.push("first");
					})
					.then(() => waiterOrder.push("first-done")),
				fileTime
					.withLock("/locked/file.ts", async () => {
						waiterOrder.push("second");
					})
					.then(() => waiterOrder.push("second-done")),
			]);
			expect([...waiterOrder].sort()).toEqual([
				"first",
				"first-done",
				"second",
				"second-done",
			]);
			expect(waiterOrder.indexOf("first")).toBeLessThan(
				waiterOrder.indexOf("second"),
			);
			expect(unhandled).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
