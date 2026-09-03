/**
 * #2526 round 2, F1: the `config_resolved` claim must be re-armed at the
 * SESSION BOUNDARY index.ts owns, not inside `handleSessionStart`.
 *
 * `tests/clients/config-resolved-phase.test.ts` drives
 * `loadLSPConfig -> handleSessionStart -> loadLSPConfig`, an ordering index.ts
 * never performs. The real closure is:
 *
 *   index.ts   ensureLSPConfigInitialized(ctx.cwd)   -> loadLSPConfig -> ROW
 *   index.ts   handleSessionStart(...)               -> (re-arm lived here)
 *   deferred   loadLSPConfig(cwd)                    -> ROW AGAIN
 *
 * so a re-arm inside the handler fires BETWEEN the session's own two config
 * resolutions and the first session of a process writes TWO rows while every
 * later session — whose `ensureLSPConfigInitialized` is short-circuited by the
 * process-lifetime `_lspConfigInitializedCwds` memo — writes one. A smell that
 * counts rows per session cannot survive that.
 *
 * This file replays index.ts's own ordering through the pi mock, so a re-arm
 * that drifts back inside the handler reds here.
 *
 * The "deferred load" is driven as a direct `loadLSPConfig(cwd)` call after the
 * emit resolves: that is literally the function `runtime-session.ts`'s
 * `setImmediate(() => loadLSPConfig(cwd))` calls, and the property under test
 * is only that it runs AFTER `handleSessionStart` returned. Forcing full
 * startup mode to get the real `setImmediate` would drag the whole scan
 * bootstrap (knip/jscpd/dep) into a wiring test for no added fidelity.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.js";
import {
	clearLatencyLog,
	flushLatencyLog,
	getLatencyLogPath,
} from "../clients/latency-logger.js";
import { _resetSessionLifecycleForTests } from "../clients/session-lifecycle.js";
import {
	flushSessionStartLog,
	SESSIONSTART_LOG_FILE,
} from "../clients/sessionstart-logger.js";
import { makeSessionStartEvent } from "./support/host-event-factory.js";
import { createPiMock, makeCtx } from "./support/pi-mock.js";
import { removeTempDirSync } from "./clients/test-utils.js";

interface ConfigResolvedRow {
	filePath: string;
	metadata: { sessionId?: string; documents?: unknown[]; recordCount?: number };
}

async function configResolvedRows(): Promise<ConfigResolvedRow[]> {
	await flushLatencyLog();
	const file = getLatencyLogPath();
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((entry) => entry.phase === "config_resolved")
		.map((entry) => ({
			filePath: String(entry.filePath ?? ""),
			metadata: (entry.metadata ?? {}) as ConfigResolvedRow["metadata"],
		}));
}

function sessionStartOffset(): number {
	return fs.existsSync(SESSIONSTART_LOG_FILE)
		? fs.statSync(SESSIONSTART_LOG_FILE).size
		: 0;
}

async function sessionStartLinesSince(
	offset: number,
	needle: string,
): Promise<string[]> {
	await flushSessionStartLog();
	if (!fs.existsSync(SESSIONSTART_LOG_FILE)) return [];
	const buffer = fs.readFileSync(SESSIONSTART_LOG_FILE);
	const tail = buffer.length < offset ? buffer : buffer.subarray(offset);
	return tail
		.toString("utf8")
		.split(/\r?\n/)
		.filter((line) => line.includes(needle));
}

const roots: string[] = [];
let previousStartupMode: string | undefined;
let previousTestMode: string | undefined;

beforeEach(async () => {
	_resetSessionLifecycleForTests();
	previousStartupMode = process.env.PI_LENS_STARTUP_MODE;
	process.env.PI_LENS_STARTUP_MODE = "quick";
	previousTestMode = process.env.PI_LENS_TEST_MODE;
	process.env.PI_LENS_TEST_MODE = "0";
	clearLatencyLog();
	await flushLatencyLog();
});

afterEach(async () => {
	await flushLatencyLog();
	_resetSessionLifecycleForTests();
	if (previousStartupMode === undefined) {
		delete process.env.PI_LENS_STARTUP_MODE;
	} else {
		process.env.PI_LENS_STARTUP_MODE = previousStartupMode;
	}
	if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
	else process.env.PI_LENS_TEST_MODE = previousTestMode;
	const { resetLSPConfigStateForTests } =
		await import("../clients/lsp/config.js");
	resetLSPConfigStateForTests();
	for (const dir of roots.splice(0)) removeTempDirSync(dir);
});

/** A fresh workspace, so index.ts's process-lifetime cwd memo cannot skip it. */
function freshRoot(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cfgres-wiring-")),
	);
	roots.push(dir);
	fs.writeFileSync(
		path.join(dir, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: ["gopls"] } }),
	);
	return dir;
}

describe("index.ts session_start: ONE config_resolved row per session (#2526 R2 F1)", () => {
	it("ensure -> session_start -> deferred load writes exactly one row", async () => {
		const root = freshRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();

		// index.ts's own ordering: `ensureLSPConfigInitialized` resolves config
		// BEFORE `handleSessionStart` runs, both inside this one emit.
		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-1" }),
		);
		const afterStart = await configResolvedRows();
		expect(
			afterStart,
			"the session_start ensure must write the session's row",
		).toHaveLength(1);

		// The deferred load `runtime-session.ts` schedules for this same session.
		const { loadLSPConfig } = await import("../clients/lsp/config.js");
		await loadLSPConfig(root);

		expect(
			await configResolvedRows(),
			"handleSessionStart re-armed the claim mid-session: the deferred load wrote a SECOND row",
		).toHaveLength(1);
	}, 30000);

	it("a second session start re-arms the claim, so it gets its own row", async () => {
		const rootA = freshRoot();
		const rootB = freshRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: rootA, sessionId: "host-session-1" }),
		);
		expect(await configResolvedRows()).toHaveLength(1);

		// A genuine new session in a different root. index.ts's closure re-arms
		// before its own ensure, so this session records too.
		_resetSessionLifecycleForTests();
		await pi.emit(
			"session_start",
			makeSessionStartEvent({ reason: "new" }),
			makeCtx({ cwd: rootB, sessionId: "host-session-2" }),
		);
		const rows = await configResolvedRows();
		expect(
			rows,
			"the second session never recorded its resolution",
		).toHaveLength(2);
		expect(
			rows[0].metadata.sessionId,
			"each session's row must carry its OWN session identity",
		).not.toBe(rows[1].metadata.sessionId);
	}, 30000);

	it("the row's session id matches the session-start expectation line's", async () => {
		const root = freshRoot();
		const pi = createPiMock();
		extension(pi.asExtensionAPI());
		clearLatencyLog();
		await flushLatencyLog();
		const offset = sessionStartOffset();

		await pi.emit(
			"session_start",
			makeSessionStartEvent(),
			makeCtx({ cwd: root, sessionId: "host-session-1" }),
		);

		const rows = await configResolvedRows();
		expect(rows).toHaveLength(1);
		const rowSessionId = rows[0].metadata.sessionId;
		expect(typeof rowSessionId, "the row must carry a session id").toBe(
			"string",
		);

		const lines = await sessionStartLinesSince(
			offset,
			"session_start config-resolution",
		);
		expect(
			lines,
			"handleSessionStart must publish this session's config-resolution expectation",
		).toHaveLength(1);
		expect(lines[0]).toContain(`session=${rowSessionId}`);
		// LSP is enabled and this is not a subagent session, so a resolution IS
		// expected — the analyzer counts this session against its row.
		expect(lines[0]).toContain("expected=true");
	}, 30000);
});
