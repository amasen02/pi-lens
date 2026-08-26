/** Cross-process mutual exclusion for the machine-global instance registry. */

import * as fs from "node:fs";
import * as path from "node:path";
import { recordDegradationOnce } from "./degradation-ledger.js";

const LOCK_STALE_MS = 5_000;
const LOCK_WAIT_MS = 500;
const LOCK_MIN_BACKOFF_MS = 5;
const LOCK_MAX_BACKOFF_MS = 25;

function lockPath(target: string): string {
	return `${target}.lock`;
}

function ownerPid(lock: string): number | undefined {
	try {
		const pid = Number(fs.readFileSync(lock, "utf8").trim().split(/\s+/)[0]);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function isPidAlive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
	}
}

function staleLock(lock: string): boolean {
	try {
		const stat = fs.statSync(lock);
		return (
			Date.now() - stat.mtimeMs > LOCK_STALE_MS || !isPidAlive(ownerPid(lock))
		);
	} catch {
		return false;
	}
}

function recordLockTimeout(target: string): void {
	recordDegradationOnce({
		kind: "instance-registry-lock-timeout",
		subject: String(process.pid),
		reason: `lock acquisition exhausted for ${path.basename(target)}`,
	});
}

function backoff(): void {
	const delay =
		LOCK_MIN_BACKOFF_MS +
		Math.floor(Math.random() * (LOCK_MAX_BACKOFF_MS - LOCK_MIN_BACKOFF_MS + 1));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
}

function takeOverStale(lock: string): void {
	if (!staleLock(lock)) return;
	const displaced = `${lock}.stale-${process.pid}-${Date.now()}`;
	try {
		fs.renameSync(lock, displaced);
		fs.unlinkSync(displaced);
	} catch {
		// Another owner may have released or taken over it first.
	}
}

function isLockContention(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EEXIST" || code === "EPERM" || code === "EBUSY";
}

export async function withInstanceRegistryLock<T>(
	target: string,
	op: () => Promise<T>,
): Promise<T | undefined> {
	const lock = lockPath(target);
	const deadline = Date.now() + LOCK_WAIT_MS;
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	while (Date.now() <= deadline) {
		let handle: fs.promises.FileHandle | undefined;
		try {
			handle = await fs.promises.open(lock, "wx");
		} catch (error) {
			if (!isLockContention(error)) throw error;
			takeOverStale(lock);
			if (Date.now() <= deadline)
				await new Promise((resolve) =>
					setTimeout(resolve, 5 + Math.floor(Math.random() * 21)),
				);
			continue;
		}
		try {
			await handle.writeFile(`${process.pid} ${Date.now()}\n`);
			return await op();
		} finally {
			await handle.close();
			await fs.promises.unlink(lock).catch(() => {});
		}
	}
	recordLockTimeout(target);
	return undefined;
}

export function withInstanceRegistryLockSync<T>(
	target: string,
	op: () => T,
): T | undefined {
	const lock = lockPath(target);
	const deadline = Date.now() + LOCK_WAIT_MS;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	while (Date.now() <= deadline) {
		try {
			const fd = fs.openSync(lock, "wx");
			try {
				fs.writeSync(fd, `${process.pid} ${Date.now()}\n`);
				return op();
			} finally {
				fs.closeSync(fd);
				try {
					fs.unlinkSync(lock);
				} catch {
					// A stale takeover may have displaced the lock after a crash.
				}
			}
		} catch (error) {
			if (!isLockContention(error)) throw error;
			takeOverStale(lock);
			if (Date.now() <= deadline) backoff();
		}
	}
	recordLockTimeout(target);
	return undefined;
}
