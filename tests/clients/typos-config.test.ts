import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	findLocalTyposConfig,
	LOCAL_TYPOS_CONFIG_NAMES,
} from "../../clients/typos-config.js";
import { removeTempDirSync } from "./test-utils.js";

describe("findLocalTyposConfig (#283)", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "typos-cfg-"));
	});
	afterEach(() => {
		removeTempDirSync(root);
	});

	it("finds a root-level typos.toml", () => {
		const cfg = path.join(root, "typos.toml");
		fs.writeFileSync(cfg, "[default]\n");
		expect(findLocalTyposConfig(root)).toBe(cfg);
	});

	it.each([...LOCAL_TYPOS_CONFIG_NAMES])("discovers %s", (name) => {
		const cfg = path.join(root, name);
		fs.writeFileSync(cfg, "[default]\n");
		expect(findLocalTyposConfig(root)).toBe(cfg);
	});

	it("walks up from a nested start dir", () => {
		const cfg = path.join(root, "_typos.toml");
		fs.writeFileSync(cfg, "[default]\n");
		const nested = path.join(root, "a", "b");
		fs.mkdirSync(nested, { recursive: true });
		expect(findLocalTyposConfig(nested)).toBe(cfg);
	});

	it("returns undefined when no config exists", () => {
		expect(findLocalTyposConfig(root)).toBeUndefined();
	});

	// #2472 review F2: findLocalTyposConfig delegates to the shared
	// findLocalToolConfig walker in path-utils.ts, which climbed to the
	// filesystem root with NO $HOME ceiling before this fold — the same
	// #250/#253 defect class every other ancestor-project-root walker in the
	// codebase already guards against via isAtOrAboveHomeDir. A config that
	// sits AT an injected home directory, with the search starting BELOW it,
	// must not be found.
	it("stops the ancestor climb at the injected HOME ceiling (#2472 review F2)", () => {
		const cfg = path.join(root, "typos.toml");
		fs.writeFileSync(cfg, "[default]\n");
		const homeDir = path.join(root, "home");
		const startDir = path.join(homeDir, "project", "src");
		fs.mkdirSync(startDir, { recursive: true });

		expect(findLocalTyposConfig(startDir, homeDir)).toBeUndefined();

		// Cross-form (forward-slash) startDir must be guarded identically.
		const crossFormStartDir = startDir.split(path.sep).join("/");
		expect(findLocalTyposConfig(crossFormStartDir, homeDir)).toBeUndefined();
	});
});
