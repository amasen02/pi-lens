import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withInstanceRegistryLock } from "../../clients/instance-registry-lock.js";
import { getDegradationSummary } from "../../clients/degradation-ledger.js";
import { removeTempDirSync } from "./test-utils.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("instance registry lock", () => {
	it("takes over an old lock owned by a dead pid", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		const lock = `${target}.lock`;
		fs.writeFileSync(lock, "999999 0\n");
		const old = new Date(Date.now() - 10_000);
		fs.utimesSync(lock, old, old);

		await expect(
			withInstanceRegistryLock(target, async () => "acquired"),
		).resolves.toBe("acquired");
		expect(fs.existsSync(lock)).toBe(false);
	});

	it("records one bounded degradation when contention exhausts the wait", async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-registry-lock-"),
		);
		dirs.push(dir);
		const target = path.join(dir, "instances.json");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${target}.lock`, `${process.pid} ${Date.now()}\n`);

		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		await expect(
			withInstanceRegistryLock(target, async () => "not reached"),
		).resolves.toBeUndefined();
		expect(getDegradationSummary()).toContainEqual(
			expect.objectContaining({
				kind: "instance-registry-lock-timeout",
				count: 1,
			}),
		);
		fs.unlinkSync(`${target}.lock`);
	});
});
