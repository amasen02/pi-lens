/**
 * #2504 AC3 — `buildActionableWarningsReport` must be bounded.
 *
 * The reported turn awaited this function on the turn_end hook with 154 files
 * and NO primed LSP cache: it opened every one of them in an LSP client and
 * pulled fresh per-file diagnostics serially at ~880 ms each —
 * `actionable_warnings_report durationMs 187891` for `warnings: 0`, with
 * `~/.claude/plans/*.md` among the files it opened.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LSPCodeAction } from "../../clients/lsp/client.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { removeTempDirSync } from "./test-utils.js";

const openFile = vi.fn(async () => undefined);
let getDiagnosticsDelayMs = 0;
const getDiagnostics = vi.fn(async () => {
	if (getDiagnosticsDelayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, getDiagnosticsDelayMs));
	}
	return [];
});
const codeAction = vi.fn(async (): Promise<LSPCodeAction[]> => []);
/** Files whose diagnostics the dispatch pipeline primed this turn. */
let primedFiles = new Set<string>();
const getLastKnownDiagnostics = vi.fn((filePath: string) =>
	primedFiles.has(filePath.replace(/\\/g, "/").toLowerCase())
		? []
		: undefined,
);

vi.mock("../../clients/lsp/index.js", () => ({
	getLSPService: () => ({
		supportsLSP: (filePath: string) => filePath.endsWith(".ts"),
		openFile,
		getDiagnostics,
		codeAction,
		getLastKnownDiagnostics,
	}),
}));

let tmpDir: string;
let outsideDir: string;

function prime(filePath: string): void {
	primedFiles.add(filePath.replace(/\\/g, "/").toLowerCase());
}

function makeFiles(dir: string, count: number, prefix = "f"): string[] {
	fs.mkdirSync(dir, { recursive: true });
	const made: string[] = [];
	for (let i = 0; i < count; i++) {
		const p = path.join(dir, `${prefix}${i}.ts`);
		fs.writeFileSync(p, `export const v${i} = ${i};\n`);
		made.push(p);
	}
	return made;
}

beforeEach(() => {
	openFile.mockClear();
	getDiagnostics.mockClear();
	codeAction.mockClear();
	getLastKnownDiagnostics.mockClear();
	getDiagnosticsDelayMs = 0;
	primedFiles = new Set();
	resetDegradationLedger();
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2504-aw-"));
	outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2504-out-"));
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	removeTempDirSync(outsideDir);
	resetDegradationLedger();
});

async function load() {
	return await import("../../clients/actionable-warnings.js");
}

describe("#2504 AC3 — project-root filter", () => {
	it("never opens a file from outside the project root", async () => {
		const { buildActionableWarningsReport } = await load();
		const inside = makeFiles(path.join(tmpDir, "src"), 1)[0];
		const outside = makeFiles(outsideDir, 1, "stray")[0];
		prime(inside);
		prime(outside);

		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files: [inside, outside],
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
		});

		const touched = [
			...getLastKnownDiagnostics.mock.calls.map((c) => String(c[0])),
			...openFile.mock.calls.map((c) => String(c[0])),
			...getDiagnostics.mock.calls.map((c) => String(c[0])),
		].map((p) => p.replace(/\\/g, "/"));
		expect(touched.length).toBeGreaterThan(0);
		for (const p of touched) {
			expect(p).not.toContain("stray0.ts");
		}
	});
});

describe("#2504 AC3 — file cap", () => {
	it("stops after the file cap and records a visible degradation", async () => {
		const { buildActionableWarningsReport } = await load();
		const files = makeFiles(path.join(tmpDir, "src"), 40);
		for (const f of files) prime(f);

		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspFileCap: 8,
		});

		expect(getLastKnownDiagnostics.mock.calls.length).toBeLessThanOrEqual(8);
		const kinds = getDegradationSummary().map((g) => g.kind);
		expect(kinds).toContain("actionable-warnings-cap");
	});
});

describe("#2504 AC3 — wall budget", () => {
	it("stops the in-band fresh-pull loop when the total budget is spent", async () => {
		const { buildActionableWarningsReport } = await load();
		const files = makeFiles(path.join(tmpDir, "src"), 20);
		// One primed file, so the turn HAS primed the cache and the cold pulls
		// stay on the awaited hook — the budget is the only thing that can stop
		// them.
		prime(files[0]);
		getDiagnosticsDelayMs = 20;

		await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			lspBudgetMs: 60,
		});

		expect(getDiagnostics.mock.calls.length).toBeLessThan(19);
		const kinds = getDegradationSummary().map((g) => g.kind);
		expect(kinds).toContain("actionable-warnings-cap");
	});
});

describe("#2504 AC3 — cold cache moves the fresh-pull loop off the awaited hook", () => {
	it("returns without a single fresh pull and delivers via the cached channel", async () => {
		const { buildActionableWarningsReport, _awaitDeferredLspPullForTest } =
			await load();
		const files = makeFiles(path.join(tmpDir, "src"), 6);
		// Nothing primed: every file would need a ~880 ms fresh round trip.
		const deferred: unknown[] = [];

		const report = await buildActionableWarningsReport({
			cwd: tmpDir,
			sessionId: "lens-test",
			turnIndex: 1,
			files,
			modifiedRangesByFile: new Map(),
			dispatchWarnings: [],
			includeLspCodeActions: true,
			onDeferredReport: (r: unknown) => deferred.push(r),
		});

		expect(report).toBeDefined();
		// The awaited hook did NO fresh LSP work.
		expect(getDiagnostics).not.toHaveBeenCalled();
		expect(openFile).not.toHaveBeenCalled();

		await _awaitDeferredLspPullForTest();

		// ...but the work still happened, off-hook, and was delivered.
		expect(getDiagnostics.mock.calls.length).toBeGreaterThan(0);
		expect(deferred.length).toBe(1);
	});
});
