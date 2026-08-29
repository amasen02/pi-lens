// Regression guard for #2347: the napi runner had no embedded-`<script>`
// coverage where the ast-grep LSP/CLI did. The ast-grep 0.45.1 CLI resolves
// every HTML `<script>` body as JavaScript and runs `language: JavaScript`
// rules inside it (verified by direct CLI repro: a `no-global-eval-js`
// violation inside a script block fires at its file line/column). The napi
// fallback simply skipped every JS/TS/TSX rule as a `language` mismatch on an
// HTML file, returning zero embedded findings while the LSP returned hundreds.
//
// The fix reparses each inline script body with the addon's js grammar in
// `evaluateAstGrepRules` and runs `language: JavaScript` rules there,
// translating findings back to file coordinates. This file drives the REAL
// seams: the loaded addon, the real html and js grammars, the real bundled
// rule catalog, a real `.html` fixture on disk, and (for the skip-record
// observability pen) the real `latency.log` sink.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import astGrepNapiRunner, {
	collectHtmlScriptInjections,
	evaluateAstGrepRules,
	loadSg,
	resetAstGrepUnsupportedLanguageLog,
} from "../../../../clients/dispatch/runners/ast-grep-napi.js";
import type { Diagnostic } from "../../../../clients/dispatch/types.js";
import type { AstGrepNapi } from "../../../../clients/deps/ast-grep-napi.js";
import { getGlobalPiLensDir } from "../../../../clients/file-utils.js";
import {
	linesFor,
	makeRealRunnerEnv,
	napiFallbackHasTool,
	type RealRunnerEnv,
} from "../../../support/real-runner-ctx.js";

vi.mock("../../../../clients/lsp/wait-policy/index.js", () => ({
	resolveAstGrepNativeExe: () => undefined,
}));

let sgModule: AstGrepNapi;
let env: RealRunnerEnv;

beforeAll(async () => {
	env = makeRealRunnerEnv({ hasTool: napiFallbackHasTool });
	// Fail loudly rather than let every assertion pass on an addon that never
	// loaded — a missing native binding turns "does not fire" into a vacuous
	// green (the #448 rule).
	const loaded = await loadSg();
	if (!loaded) {
		throw new Error(
			"@ast-grep/napi did not load; every embedded-script assertion here would be vacuous",
		);
	}
	sgModule = loaded;
});

afterAll(() => env.cleanup());

afterEach(() => {
	resetAstGrepUnsupportedLanguageLog();
});

/** Evaluate against a real on-disk `.html` fixture through the shared seam. */
function evaluateHtml(content: string): Diagnostic[] {
	const { ctx } = env.addFile("embed.html", content, { kind: "html" });
	const rootNode = sgModule.html.parse(content).root();
	return evaluateAstGrepRules(ctx.filePath, rootNode, env.cwd, "html", {
		content,
		sgModule,
		log: () => {},
	});
}

describe("embedded <script> coverage (#2347)", () => {
	it("runs a language: JavaScript rule inside an inline script (red on pre-fix)", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<head></head>",
			"<body>",
			"<script>",
			"function run(code) {",
			"  eval(code);",
			"}",
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		const finding = diagnostics.find((d) => d.rule === "no-global-eval-js");

		expect(finding).toBeDefined();
		// File-absolute, not body-relative: `eval` sits on line 7 of the file
		// (0-based body line 2 inside the script body), column 3.
		expect(finding?.line).toBe(7);
		expect(finding?.column).toBe(3);
	});

	it("translates a same-line inline script back to the file column", () => {
		const content = '<!doctype html>\n<script>eval("x=1")</script>\n';

		const diagnostics = evaluateHtml(content);
		const finding = diagnostics.find((d) => d.rule === "no-global-eval-js");

		expect(finding).toBeDefined();
		// `eval` begins after the 8-byte `<script>` tag on line 2.
		expect(finding?.line).toBe(2);
		expect(finding?.column).toBe(9);
	});

	it("runs JS rules in every script block with per-block positions", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<head></head>",
			"<body>",
			"<script>",
			'  eval("a");',
			"</script>",
			"<script>",
			'  eval("b");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const lines = linesFor(evaluateHtml(content), "no-global-eval-js");

		expect(lines).toEqual([6, 9]);
	});

	it("injects a src-bearing script body, matching the CLI (unconditional)", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			'<script src="extern.js">',
			'  eval("x");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		expect(diagnostics.some((d) => d.rule === "no-global-eval-js")).toBe(true);
	});

	it("injects a type=application/json body, matching the CLI (type-agnostic)", () => {
		// Verified against the ast-grep 0.45.1 CLI: a duplicate-key JSON object
		// inside a `type="application/json"` script fires `no-dupe-keys-js`.
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			'<script type="application/json">',
			'{"a": 1, "a": 2}',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		const finding = diagnostics.find((d) => d.rule === "no-dupe-keys-js");
		expect(finding).toBeDefined();
		expect(finding?.line).toBe(5);
		expect(finding?.column).toBe(2);
	});

	it("does not run TypeScript rules inside scripts, matching the CLI", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>",
			'console.log("hi");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");

		const ruleIds = new Set(evaluateHtml(content).map((d) => d.rule));

		// The JS twin fires; the TypeScript twin (`no-console-except-error`)
		// must not — ast-grep 0.45.1 runs only `language: JavaScript` rules
		// inside script bodies.
		expect(ruleIds.has("no-console-except-error-js")).toBe(true);
		expect(ruleIds.has("no-console-except-error")).toBe(false);
	});

	it("produces no embedded finding for an HTML file without scripts", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			'<body><div class="btn">Go</div></body>',
			"</html>",
		].join("\n");

		const diagnostics = evaluateHtml(content);
		expect(diagnostics.some((d) => d.rule === "no-global-eval-js")).toBe(false);

		// The skip path (not injection) is the countable state.
		const rootNode = sgModule.html.parse(content).root();
		expect(collectHtmlScriptInjections(rootNode, sgModule)).toHaveLength(0);
	});

	it("drives the full runner against the real fixture", async () => {
		const { ctx } = env.addFile(
			"embed-runner.html",
			[
				"<!doctype html>",
				"<html>",
				"<body>",
				"<script>",
				'  eval("x");',
				"</script>",
				"</body>",
				"</html>",
			].join("\n"),
			{ kind: "html" },
		);
		const result = await astGrepNapiRunner.run(ctx);
		expect(result.diagnostics.some((d) => d.rule === "no-global-eval-js")).toBe(
			true,
		);
		expect(result.status).toBe("failed");
		expect(result.semantic).toBe("blocking");
	});
});

describe("collectHtmlScriptInjections (#2347)", () => {
	it("extracts each script body with its file byte offset", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>const a = 1;</script>",
			"<script>const b = 2;</script>",
			"</body>",
			"</html>",
		].join("\n");
		const rootNode = sgModule.html.parse(content).root();
		const injections = collectHtmlScriptInjections(rootNode, sgModule);

		expect(injections).toHaveLength(2);
		expect(injections[0].body).toBe("const a = 1;");
		expect(injections[1].body).toBe("const b = 2;");
		// Byte offsets strictly increasing and inside the file.
		expect(injections[0].startByte).toBeLessThan(injections[1].startByte);
		expect(injections[1].startByte).toBeLessThan(
			Buffer.byteLength(content, "utf8"),
		);
	});

	it("skips whitespace-only and empty script bodies", () => {
		const content = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>   </script>",
			"<script></script>",
			"</body>",
			"</html>",
		].join("\n");
		const rootNode = sgModule.html.parse(content).root();
		expect(collectHtmlScriptInjections(rootNode, sgModule)).toHaveLength(0);
	});

	it("handles an HTML file with no script elements at all", () => {
		const content = "<!doctype html>\n<html><body>plain</body></html>\n";
		const rootNode = sgModule.html.parse(content).root();
		expect(collectHtmlScriptInjections(rootNode, sgModule)).toHaveLength(0);
	});
});

describe("embedded-script skip-record observability (#2347)", () => {
	// The real latency sink (hermetic worker PI_LENS_HOME) — the #1742
	// real-sinks rule. Scoped PI_LENS_TEST_MODE=0 turns the latency logger's
	// test-mode no-op off for this test only.
	let previousTestMode: string | undefined;
	let flushLatencyLog: (() => Promise<void>) | undefined;

	beforeEach(() => {
		previousTestMode = process.env.PI_LENS_TEST_MODE;
		process.env.PI_LENS_TEST_MODE = "0";
		fs.rmSync(path.join(getGlobalPiLensDir(), "latency.log"), {
			force: true,
		});
	});
	afterEach(async () => {
		if (flushLatencyLog) await flushLatencyLog();
		flushLatencyLog = undefined;
		if (previousTestMode === undefined) delete process.env.PI_LENS_TEST_MODE;
		else process.env.PI_LENS_TEST_MODE = previousTestMode;
	});

	async function readSkippedRecord(): Promise<
		Record<string, { htmlInlineScriptCount?: number }>
	> {
		vi.resetModules();
		const latencyLogger = await import("../../../../clients/latency-logger.js");
		flushLatencyLog = latencyLogger.flushLatencyLog;
		await latencyLogger.flushLatencyLog();
		const logPath = path.join(getGlobalPiLensDir(), "latency.log");
		const records = fs
			.readFileSync(logPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const record = records.find(
			(entry) => entry.phase === "astgrep_napi_unsupported_rules_skipped",
		);
		return (
			(
				record?.metadata as {
					skippedByLanguage?: Record<
						string,
						{ htmlInlineScriptCount?: number }
					>;
				}
			)?.skippedByLanguage ?? {}
		);
	}

	it("marks a scriptless HTML file's javascript mismatch with htmlInlineScriptCount 0", async () => {
		const { filePath } = env.addFile(
			"scriptless.html",
			"<!doctype html>\n<html><body>plain</body></html>\n",
			{ kind: "html" },
		);
		const rootNode = sgModule.html
			.parse("<!doctype html>\n<html><body>plain</body></html>\n")
			.root();

		evaluateAstGrepRules(filePath, rootNode, env.cwd, "html", {
			sgModule,
			content: "<!doctype html>\n<html><body>plain</body></html>\n",
			log: () => {},
			unsupportedLanguageLog: new Set<string>(),
		});

		const skipped = await readSkippedRecord();
		expect(skipped["mismatch:javascript->html"]?.htmlInlineScriptCount).toBe(0);
	});

	it("emits javascript->html mismatch only when no script ran, and counts scripts otherwise", async () => {
		const withScripts = [
			"<!doctype html>",
			"<html>",
			"<body>",
			"<script>",
			'  eval("x");',
			"</script>",
			"</body>",
			"</html>",
		].join("\n");
		const { filePath } = env.addFile("with-scripts.html", withScripts, {
			kind: "html",
		});
		const rootNode = sgModule.html.parse(withScripts).root();

		evaluateAstGrepRules(filePath, rootNode, env.cwd, "html", {
			sgModule,
			content: withScripts,
			log: () => {},
			unsupportedLanguageLog: new Set<string>(),
		});

		const skipped = await readSkippedRecord();
		// JS rules RAN inside the script, so no mismatch entry for javascript->html.
		expect(skipped["mismatch:javascript->html"]).toBeUndefined();
		// TS/TSX rules still mismatch, and the record names the script count.
		const ts = skipped["mismatch:typescript->html"];
		expect(ts).toBeDefined();
		expect(ts.htmlInlineScriptCount).toBe(1);
		expect(skipped["mismatch:tsx->html"]?.htmlInlineScriptCount).toBe(1);
	});
});
