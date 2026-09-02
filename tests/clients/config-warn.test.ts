import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONFIG_DIAGNOSTIC_MARKER_PATTERN,
	isConfigDiagnosticCode,
} from "../../clients/config-diagnostic-codes.js";
import {
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
			subject: `/tmp/a.json${NUL}`,
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
			`/tmp/a.json${NUL}`,
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
