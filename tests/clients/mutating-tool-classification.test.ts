/**
 * #2423 — the inbound mutation-classification seam.
 *
 * The behavioral cases here deliberately import NO new module. They drive the
 * production entry points (`handleToolResult`, `handleToolCall`, `handleAgentEnd`)
 * with a third-party tool name and assert on real `CacheManager` /
 * `RuntimeCoordinator` state, so each one fails on an ASSERTION against pre-fix
 * code rather than on a missing import. The registry and mutation-proof cases
 * pull `clients/mutating-tool.js` through a dynamic import for the same reason.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CacheManager } from "../../clients/cache-manager.js";
import { readChangesSince } from "../../clients/project-changes.js";
import { handleAgentEnd } from "../../clients/runtime-agent-end.js";
import { RuntimeCoordinator } from "../../clients/runtime-coordinator.js";
import { handleToolResult } from "../../clients/runtime-tool-result.js";
import { setupTestEnvironment } from "./test-utils.js";

vi.mock("../../clients/pipeline.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/pipeline.js")>();
	return { ...actual, runPipeline: vi.fn() };
});

vi.mock("../../clients/lsp/index.js", () => ({
	notifyExternalFileChange: vi.fn(async () => undefined),
}));

const SOURCE = ["const a = 1;", "const b = 2;", "const c = 3;", ""].join("\n");

async function stubPipeline(): Promise<void> {
	const { runPipeline } = await import("../../clients/pipeline.js");
	vi.mocked(runPipeline).mockResolvedValue({
		output: "",
		hasBlockers: false,
		isError: false,
		fileModified: false,
	} as never);
}

function toolResultDeps(args: {
	event: unknown;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
}): Parameters<typeof handleToolResult>[0] {
	return {
		event: args.event,
		getFlag: (name: string) => name === "no-lsp",
		dbg: () => {},
		runtime: args.runtime,
		cacheManager: args.cacheManager,
		biomeClient: {},
		ruffClient: {},
		metricsClient: {},
		resetLSPService: () => {},
		agentBehaviorRecord: () => [],
		formatBehaviorWarnings: () => "",
	} as unknown as Parameters<typeof handleToolResult>[0];
}

/**
 * One `hashline-edit-pro` `replace` call, the exact shape the reporter's host
 * emits: no `details.diff`, an inclusive anchor range, and a tool name pi-lens
 * has never heard of.
 */
function replaceEvent(filePath: string): Record<string, unknown> {
	return {
		toolName: "replace",
		toolCallId: "call-replace-1",
		input: {
			path: filePath,
			remove_from: "2",
			remove_to: "3",
			replacement_lines: ["const b = 20;", "const c = 30;"],
		},
		content: [{ type: "text", text: "replaced" }],
	};
}

/** One `hashline-edit-pro` `insert` call. */
function insertEvent(filePath: string): Record<string, unknown> {
	return {
		toolName: "insert",
		toolCallId: "call-insert-1",
		input: {
			path: filePath,
			anchor: "2: const b = 2;",
			direction: "after",
			lines: ["const b2 = 22;"],
		},
		content: [{ type: "text", text: "inserted" }],
	};
}

describe("#2423 acceptance 1 — a third-party edit reaches the bookkeeping chain", () => {
	it("records turn state and a change-log receipt for a `replace` tool_result", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-replace-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "replaced.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-replace" });
			runtime.beginTurn();

			await handleToolResult(
				toolResultDeps({
					event: replaceEvent(filePath),
					runtime,
					cacheManager,
				}),
			);

			const files = Object.keys(
				cacheManager.readTurnState(env.tmpDir).files ?? {},
			);
			expect(files.length).toBeGreaterThan(0);
			expect(files[0]).toContain("replaced.ts");

			// The adapter resolved remove_from/remove_to to lines 2-3, so the
			// recorded range is the tool's own, not a whole-file guess.
			const recorded = cacheManager.readTurnState(env.tmpDir).files[files[0]];
			expect(recorded.modifiedRanges).toEqual([{ start: 2, end: 3 }]);

			// The change log names the tool instead of collapsing onto agent-edit.
			expect(readChangesSince(env.tmpDir, 0)).toMatchObject([
				{ source: "agent-tool:replace", filePath },
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("queues a `replace` for the deferred pass and the agent_settled drain formats it", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-drain-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "drained.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-drain" });
			runtime.beginTurn();

			await handleToolResult(
				toolResultDeps({
					event: replaceEvent(filePath),
					runtime,
					cacheManager,
				}),
			);

			// Deferred, never immediate: an unknown edit-shaped tool takes the
			// safe timing.
			expect(runtime.pendingDeferredFormatCount).toBeGreaterThan(0);

			const formatted: string[] = [];
			await handleAgentEnd({
				ctxCwd: env.tmpDir,
				getFlag: (name: string) => name === "no-lsp",
				notify: vi.fn(),
				dbg: () => {},
				runtime,
				cacheManager,
				getFormatService: () =>
					({
						recordRead: () => {},
						formatFile: async (fp: string) => {
							formatted.push(fp);
							return {
								filePath: fp,
								formatters: [],
								anyChanged: false,
								allSucceeded: true,
							};
						},
					}) as never,
			} as never);

			expect(formatted.map((fp) => path.resolve(fp))).toContain(
				path.resolve(filePath),
			);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("records an `insert` call at its anchor line", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-insert-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "inserted.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-insert" });
			runtime.beginTurn();

			await handleToolResult(
				toolResultDeps({ event: insertEvent(filePath), runtime, cacheManager }),
			);

			const state = cacheManager.readTurnState(env.tmpDir);
			const files = Object.keys(state.files ?? {});
			expect(files.length).toBeGreaterThan(0);
			expect(state.files[files[0]].modifiedRanges).toEqual([
				{ start: 2, end: 2 },
			]);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});

	it("still ignores a tool that neither names nor shapes a mutation", async () => {
		await stubPipeline();
		const env = setupTestEnvironment("pi-lens-2423-negative-");
		const previousDataDir = process.env.PILENS_DATA_DIR;
		process.env.PILENS_DATA_DIR = path.join(env.tmpDir, "data");
		try {
			const filePath = path.join(env.tmpDir, "untouched.ts");
			fs.writeFileSync(filePath, SOURCE);

			const cacheManager = new CacheManager(false);
			const runtime = new RuntimeCoordinator();
			runtime.projectRoot = env.tmpDir;
			runtime.setTelemetryIdentity({ sessionId: "s-2423-negative" });
			runtime.beginTurn();

			await handleToolResult(
				toolResultDeps({
					event: {
						toolName: "some_reader",
						toolCallId: "call-reader-1",
						input: { path: filePath, query: "b" },
						content: [{ type: "text", text: "read" }],
					},
					runtime,
					cacheManager,
				}),
			);

			expect(Object.keys(cacheManager.readTurnState(env.tmpDir).files ?? {}))
				.toHaveLength(0);
			expect(runtime.pendingDeferredFormatCount).toBe(0);
		} finally {
			if (previousDataDir === undefined) delete process.env.PILENS_DATA_DIR;
			else process.env.PILENS_DATA_DIR = previousDataDir;
			env.cleanup();
		}
	});
});

describe("#2423 — classification contract", () => {
	it("classifies pi's own tools from the built-in table", async () => {
		const { classifyMutatingTool } = await import(
			"../../clients/mutating-tool.js"
		);
		expect(
			classifyMutatingTool({ toolName: "write", input: { path: "/a.ts" } }),
		).toMatchObject({ kind: "write", provenance: "builtin", path: "/a.ts" });
		expect(
			classifyMutatingTool({ toolName: "edit", input: { path: "/a.ts" } }),
		).toMatchObject({ kind: "edit", provenance: "builtin" });
		expect(
			classifyMutatingTool({ toolName: "read", input: { path: "/a.ts" } }),
		).toBeUndefined();
	});

	it("marks a bash-derived synthetic write with its own provenance", async () => {
		const { classifyMutatingTool, PI_LENS_SYNTHETIC_MUTATION_FIELD } =
			await import("../../clients/mutating-tool.js");
		expect(
			classifyMutatingTool({
				toolName: "write",
				input: { path: "/a.ts" },
				[PI_LENS_SYNTHETIC_MUTATION_FIELD]: "bash",
			}),
		).toMatchObject({ kind: "write", provenance: "bash-derived" });
	});

	it("keeps the adapter order deterministic and first-match-wins", async () => {
		const { MUTATION_SHAPE_ADAPTERS } = await import(
			"../../clients/mutating-tool.js"
		);
		expect(MUTATION_SHAPE_ADAPTERS.map((a) => a.name)).toEqual([
			"hashline-readmap",
			"hashline-edit-pro",
		]);
	});

	// Mutation proof for the registry: each adapter owns a case that goes red if
	// its entry is deleted, because no other adapter recognizes that shape.
	it("resolves the hashline-readmap shape (red if that adapter is removed)", async () => {
		const { classifyMutatingTool } = await import(
			"../../clients/mutating-tool.js"
		);
		expect(
			classifyMutatingTool({
				toolName: "hashline_edit",
				input: {
					path: "/a.ts",
					replace_lines: { start_anchor: "4: x", end_anchor: "7: y" },
				},
			}),
		).toMatchObject({
			kind: "edit",
			source: "hashline-readmap",
			touchedLines: [4, 7],
			provenance: "declared",
		});
	});

	it("resolves the hashline-edit-pro shape (red if that adapter is removed)", async () => {
		const { classifyMutatingTool } = await import(
			"../../clients/mutating-tool.js"
		);
		expect(
			classifyMutatingTool({
				toolName: "replace",
				input: { path: "/a.ts", remove_from: "9", remove_to: "12" },
			}),
		).toMatchObject({
			kind: "edit",
			source: "hashline-edit-pro",
			touchedLines: [9, 12],
			provenance: "declared",
		});
	});

	it("blocks rather than guesses when an adapter cannot resolve its anchors", async () => {
		const { classifyMutatingTool } = await import(
			"../../clients/mutating-tool.js"
		);
		const blocked = classifyMutatingTool({
			toolName: "replace",
			input: { path: "/a.ts", remove_from: "notaline", remove_to: "12" },
		});
		expect(blocked?.touchedLines).toBeUndefined();
		expect(blocked?.preflightError).toContain("BLOCKED");
	});

	it("has no dead `multiedit` entry left in the mutating-tool table", async () => {
		const { getBuiltinMutatingToolNames, isMutatingToolName } = await import(
			"../../clients/mutating-tool.js"
		);
		expect(getBuiltinMutatingToolNames().sort()).toEqual(["edit", "write"]);
		expect(isMutatingToolName("multiedit")).toBe(false);
	});
});

// ── Grep guard ──────────────────────────────────────────────────────────────
//
// The seam only holds if it stays the single decision point. This walks
// `clients/` and fails when a mutation decision is made by comparing a tool
// name to the `"write"` / `"edit"` literals anywhere else.

const CLIENTS_DIR = path.resolve(import.meta.dirname, "..", "..", "clients");
const SEAM_FILE = path.join(CLIENTS_DIR, "mutating-tool.ts");

function walkTypeScript(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkTypeScript(full, out);
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts"))
			out.push(full);
	}
	return out;
}

const LITERAL_COMPARISONS = [
	/toolName\s*===\s*"(?:write|edit|multiedit)"/,
	/isToolCallEventType\(\s*"(?:write|edit|multiedit)"/,
	/isToolCallEventType\(\s*[A-Za-z_$][\w$]*\s*,\s*"(?:write|edit|multiedit)"/,
];

describe("#2423 grep guard — the seam is the only mutation decision point", () => {
	it("finds no tool-name literal comparison outside clients/mutating-tool.ts", () => {
		const files = walkTypeScript(CLIENTS_DIR);
		// Non-empty scan floor: a walker that silently found nothing would make
		// this suite pass for the wrong reason.
		expect(files.length).toBeGreaterThan(50);

		const offenders: string[] = [];
		for (const file of files) {
			if (path.resolve(file) === SEAM_FILE) continue;
			const lines = fs.readFileSync(file, "utf8").split("\n");
			lines.forEach((line, index) => {
				if (LITERAL_COMPARISONS.some((re) => re.test(line))) {
					offenders.push(
						`${path.relative(CLIENTS_DIR, file)}:${index + 1}: ${line.trim()}`,
					);
				}
			});
		}
		expect(offenders).toEqual([]);
	});

	it("still detects an offender when one exists (the guard is not vacuous)", () => {
		const sample = '\tif (event.toolName === "edit") return 1;';
		expect(LITERAL_COMPARISONS.some((re) => re.test(sample))).toBe(true);
		const nav = '\tif (toolName === "lsp_navigation") return 1;';
		expect(LITERAL_COMPARISONS.some((re) => re.test(nav))).toBe(false);
	});
});
