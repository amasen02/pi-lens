import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIG_DIAGNOSTIC_MARKER_PATTERN,
	isConfigDiagnosticCode,
} from "../../clients/config-diagnostic-codes.js";
import {
	normalizeParseErrorReason,
	resetIgnoredConfigWarnCache,
	warnIgnoredConfigOnce,
} from "../../clients/config-warn.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";

// #2431: `logExtension` is a no-op under `isTestMode()` (and, live, its NDJSON
// writer already redacts the serialized line — see ndjson-logger.ts). Neither
// of those defends the SOURCE this PR fixes: what `warnIgnoredConfigOnce`
// hands `logExtension` before either layer runs. Mocked here (same pattern as
// tests/clients/lsp/config.test.ts) to inspect exactly that.
const loggedExtension: Array<{
	message: string;
	metadata?: Record<string, unknown>;
}> = [];
vi.mock("../../clients/extension-log.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/extension-log.js")>();
	return {
		...actual,
		logExtension: (entry: {
			message: string;
			metadata?: Record<string, unknown>;
		}) => {
			loggedExtension.push({
				message: entry.message,
				metadata: entry.metadata,
			});
		},
	};
});

/**
 * The shared ignored-config seam (#2418 review, S1 + F6).
 *
 * S1 collapsed three near-identical warn bodies into one helper, so this file
 * pins the two things that collapse could have silently changed: the rendered
 * prose (byte-identical per subsystem, because two shipped test files assert on
 * it and users grep it today) and the warn-once latch.
 *
 * F6 is the other half. Before it, `DegradationRecord.code` and the whole
 * `PILENS_CFG_*` namespace had no emitter at all — the plumbing was dead code
 * dressed as a policy. A config the user wrote could be ignored for a whole
 * session with nothing counted anywhere; the notification was one-shot and the
 * ledger, the repo's own durable answer to "what degraded this session", knew
 * nothing about it. These tests are the proof the path is live.
 */

/**
 * The subject separator, built rather than spelled: a literal NUL in a source
 * file makes the file binary to grep and to half the repo's own scanners.
 */
const NUL = String.fromCharCode(0);

const notified: Array<{ message: string; level: string | undefined }> = [];

beforeEach(() => {
	notified.length = 0;
	loggedExtension.length = 0;
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
	wireUserNotifier(() => (message, level) => {
		notified.push({ message, level });
	});
});

afterEach(() => {
	resetUserNotifier();
	resetIgnoredConfigWarnCache();
	resetDegradationLedger();
});

function configIgnoredGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "config-ignored",
	);
}

describe("warnIgnoredConfigOnce prose (#2418)", () => {
	it.each([
		["lsp-config", "ignoring invalid LSP config"],
		["lens-config", "ignoring invalid global config"],
		["project-lens-config", "ignoring invalid project config"],
	] as const)("renders %s prose byte-identically", (subsystem, prefix) => {
		warnIgnoredConfigOnce({
			subsystem,
			file: "/tmp/a.json",
			reason: "Unexpected token }",
		});
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toBe(
			`pi-lens: ${prefix} /tmp/a.json: Unexpected token } [PILENS_CFG_0001]`,
		);
		expect(notified[0].level).toBe("warning");
	});

	it("ends in a marker a user can match on, not in prose", () => {
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		const matched = CONFIG_DIAGNOSTIC_MARKER_PATTERN.exec(notified[0].message);
		expect(matched?.[1]).toBe("PILENS_CFG_0001");
		expect(isConfigDiagnosticCode(matched?.[1])).toBe(true);
		expect(notified[0].message.endsWith("[PILENS_CFG_0001]")).toBe(true);
	});

	it("honors an explicit code override", () => {
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "legacy key",
			code: "PILENS_CFG_0002",
		});
		expect(notified[0].message.endsWith("[PILENS_CFG_0002]")).toBe(true);
	});
});

describe("warnIgnoredConfigOnce latch (#2418)", () => {
	it("warns once per (subsystem, file, key, reason)", () => {
		const warn = () =>
			warnIgnoredConfigOnce({
				subsystem: "lens-config",
				file: "/tmp/a.json",
				reason: "bad",
			});
		warn();
		warn();
		warn();
		expect(notified).toHaveLength(1);
	});

	it("warns again for a different reason on the same file", () => {
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "worse",
		});
		expect(notified).toHaveLength(2);
	});

	it("does not let one subsystem's reset un-latch another's", () => {
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		expect(notified).toHaveLength(2);

		resetIgnoredConfigWarnCache("lens-config");
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		// The lens-config one warns again; the project one is still latched.
		expect(notified).toHaveLength(3);
	});
});

describe("warnIgnoredConfigOnce ledger record (#2418 F6)", () => {
	it("records a config-ignored degradation", () => {
		expect(configIgnoredGroup()).toBeUndefined();
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "Unexpected token }",
		});
		const group = configIgnoredGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]).toEqual({
			// No key, no separator: a whole-file rejection is subject `<file>`,
			// not `<file>` plus a bare NUL separator (#2418 review R3, S1).
			subject: "/tmp/a.json",
			reason: "Unexpected token }",
		});
	});

	it("keys the subject on file AND key, so a per-key rejection is its own row", () => {
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "not an array",
			key: "rules.disable",
		});
		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/a.json",
			reason: "unreadable",
		});
		const group = configIgnoredGroup();
		expect(group?.count).toBe(2);
		expect(group?.latestReasons.map((entry) => entry.subject)).toEqual([
			`/tmp/a.json${NUL}rules.disable`,
			"/tmp/a.json",
		]);
	});

	it("counts one row per subject even when the prose warns twice", () => {
		// The latch is per (file, key, reason); the ledger is per (kind, subject).
		// Coarser on purpose: two parse errors in one file are one ignored config.
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "bad",
		});
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "worse",
		});
		expect(notified).toHaveLength(2);
		expect(configIgnoredGroup()?.count).toBe(1);
	});
});

/**
 * The session-boundary half (#2418 review round 3, F1).
 *
 * The warn-once latch is a PROCESS-lifetime Set and it sat in front of the
 * ledger record, so from session 2 onward a config that was still being
 * ignored produced no `config-ignored` row at all: `handleSessionStart` calls
 * `resetDegradationLedger()`, nothing re-armed the latch, and the early return
 * swallowed the record the new session was supposed to carry. Catalog shape 17
 * — a gate that outlives the ledger it guards silently eats the record it was
 * only ever meant to de-duplicate — the same defect `refreshGrammarSessionLatches`
 * exists to prevent in `clients/tree-sitter-client.ts`.
 */
describe("warnIgnoredConfigOnce across a session boundary (#2418 review R3 F1)", () => {
	const warn = () =>
		warnIgnoredConfigOnce({
			subsystem: "lsp-config",
			file: "/tmp/a.json",
			reason: "Unexpected token }",
		});

	it("records the ledger row again in the next session", () => {
		warn();
		expect(configIgnoredGroup()?.count).toBe(1);

		// Exactly what handleSessionStart does first thing. The config on disk
		// is still broken; session 2 must still be able to answer "did this
		// session ignore a config the user wrote".
		resetDegradationLedger();
		warn();
		expect(configIgnoredGroup()?.count).toBe(1);
		expect(configIgnoredGroup()?.latestReasons[0]).toEqual({
			subject: "/tmp/a.json",
			reason: "Unexpected token }",
		});
	});

	it("still does not re-nag the user across that boundary", () => {
		warn();
		expect(notified).toHaveLength(1);
		resetDegradationLedger();
		warn();
		// The ledger re-arms per session; the human-facing warning stays
		// once-per-process, which is what the latch is for.
		expect(notified).toHaveLength(1);
	});

	it("still records only one row per subject inside one session", () => {
		warn();
		warn();
		warn();
		expect(configIgnoredGroup()?.count).toBe(1);
	});
});

/**
 * #2431: Node's `JSON.parse` embeds a slice of the source text in its own
 * `SyntaxError#message` — `Unexpected token 'g', ..."piToken": ghp_SECRET"...
 * is not valid JSON` is the LITERAL shape from this issue's evidence. Every
 * loader used to pass `error.message` straight through as `reason`, so a
 * malformed config that happened to carry a credential leaked it into all
 * three sinks this seam owns. This section pins the fix AT the seam: a real
 * `JSON.parse` failure on content containing a `ghp_`-shaped token never
 * reaches the notification, `logExtension`'s metadata, or the ledger row.
 */
describe("warnIgnoredConfigOnce parse-error reason redaction (#2431)", () => {
	// GitHub PAT shape: `ghp_` + 36 alphanumerics. Real enough for
	// `redact/secrets.ts`'s own scanner to recognize, exactly like a config
	// author's real token would be.
	const TOKEN = `ghp_${"A".repeat(36)}`;

	function realJsonParseError(content: string): SyntaxError {
		try {
			JSON.parse(content);
		} catch (error) {
			if (error instanceof SyntaxError) return error;
			throw error;
		}
		throw new Error("expected JSON.parse to throw for this fixture");
	}

	it("normalizeParseErrorReason never keeps a JSON.parse SyntaxError's message", () => {
		// The exact evidence shape (#2431): an unquoted value next to a secret
		// token, which V8 reports with NO derivable position at all — only a
		// snippet. Node 24: `Unexpected token 'g', ..."piToken": ghp_AAAA..."...
		// is not valid JSON`.
		const error = realJsonParseError(`{"piToken": ${TOKEN}}`);
		// V8 truncates its snippet, so the raw message carries a PREFIX of the
		// token rather than all 40 chars — still a real leak (a prefix narrows a
		// brute-force search enormously), and still what this fix must strip.
		expect(error.message).toContain("ghp_");

		const reason = normalizeParseErrorReason(error);
		expect(reason).not.toContain(TOKEN);
		expect(reason).not.toContain("ghp_");
		expect(reason).toBe("SyntaxError");
	});

	it("normalizeParseErrorReason keeps line/col when V8 states one, never the message", () => {
		// `{` alone: V8 states `Expected property name or '}' in JSON at
		// position 1 (line 1 column 2)` — no snippet, but a real position.
		const error = realJsonParseError("{");
		const reason = normalizeParseErrorReason(error);
		expect(reason).toBe("SyntaxError at line 1 col 2");
	});

	it("routes a non-SyntaxError caught error (a fs error, a hand-thrown validation error) through redact/secrets.ts", () => {
		// Not `JSON.parse`'s own SyntaxError, so the message is not DOCUMENTED
		// to embed file content — but still defense-in-depth redacted (#2431
		// AC3), never trusted verbatim on the strength of "it isn't SyntaxError".
		const error = new TypeError(`expected an object, found token ${TOKEN}`);
		const reason = normalizeParseErrorReason(error);
		expect(reason).not.toContain(TOKEN);
		expect(reason).toContain("[REDACTED:github-token]");
		// Everything else about the message survives — this is defense in
		// depth, not the same total strip as the SyntaxError branch.
		expect(reason).toContain("expected an object, found token");
	});

	it("does not leak the token into the notification, logExtension metadata, or the ledger row", () => {
		const content = `{"piToken": ${TOKEN}, "other": "value"}`;
		const error = realJsonParseError(content);

		warnIgnoredConfigOnce({
			subsystem: "project-lens-config",
			file: "/tmp/.pi-lens.json",
			reason: { parseError: error },
		});

		// Sink 1: the human-facing notification.
		expect(notified).toHaveLength(1);
		expect(notified[0].message).not.toContain(TOKEN);
		expect(notified[0].message).not.toContain("ghp_");

		// Sink 2: the extension.log line `warnIgnoredConfigOnce` hands
		// `logExtension` — message AND metadata.
		expect(loggedExtension).toHaveLength(1);
		expect(loggedExtension[0].message).not.toContain(TOKEN);
		expect(loggedExtension[0].message).not.toContain("ghp_");
		expect(JSON.stringify(loggedExtension[0].metadata)).not.toContain(TOKEN);
		expect(JSON.stringify(loggedExtension[0].metadata)).not.toContain("ghp_");

		// Sink 3: the durable degradation-ledger row (subject + reason;
		// `metadata` for this kind is always just `{subsystem, configPath}` —
		// the file's PATH, never its content, so it carries no token by
		// construction — verified anyway).
		const group = configIgnoredGroup();
		expect(group?.count).toBe(1);
		const entry = group?.latestReasons[0];
		expect(entry?.subject).not.toContain(TOKEN);
		expect(entry?.reason).not.toContain(TOKEN);
		expect(entry?.reason).not.toContain("ghp_");
		expect(entry?.reason).toBe("SyntaxError");
	});

	it("a hand-authored reason (not a parse error) still passes through verbatim", () => {
		// Regression guard on the OTHER half of the union: normalization must
		// never touch a caller's own validated-value message.
		warnIgnoredConfigOnce({
			subsystem: "lens-config",
			file: "/tmp/a.json",
			reason: "widget.visible must be a boolean",
		});
		expect(notified[0].message).toContain("widget.visible must be a boolean");
	});
});
