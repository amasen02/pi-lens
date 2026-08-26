import { readFileSync } from "node:fs";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
	detectFlattenedBody,
	lintPullRequestEvent,
	lintLivePrBody,
	lintPrBody,
	repairFlattenedBody,
	resolveLivePrBody,
	resolveTouchesTests,
} from "../../scripts/check-pr-body.mjs";

const body = `Summary\nOpening context.\n\n## Tests\nTargeted tests pass.\n\n## Blast radius\nNo runtime module touched.\n\n## Class sweep\nWhole-tree grep completed.\n\n## Observability\nThe advisory check run is the record.`;
const flattenedBody =
	"## Summary Await the first lifecycle run's asynchronous word-index snapshot promotion before reseeding the current-format snapshot for the fallback run. ## Tests - Native master flake justification for the count barrier: 2/10 forced runs reproduced the promotion race. - Fixed lifecycle test: 5/5 tests passed. ### Test assessment - tests/clients/word-index-lifecycle.test.ts uniquely pins the ordering guard. ## Blast radius This change is test-only. ## Class sweep The async-persist lifecycle race is fully covered. ## Observability The test observes existing project snapshot records.";

describe("flattened PR body repair", () => {
	it("detects the clearly flattened real-world shape and repairs it", () => {
		expect(lintPrBody(flattenedBody)).toMatchObject({ valid: false });
		expect(detectFlattenedBody(flattenedBody)).toBe(true);
		const repaired = repairFlattenedBody(flattenedBody);
		expect(lintPrBody(repaired, { requireTestAssessment: true })).toEqual({
			valid: true,
			errors: [],
		});
	});

	it.each([
		body,
		"Summary\nShort body.\n\n## Tests\nDone.\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.",
	])("does not detect a normal or short valid body", (candidate) => {
		expect(detectFlattenedBody(candidate)).toBe(false);
		expect(repairFlattenedBody(candidate)).toBe(candidate);
	});

	it("does not classify a long valid body with incidental inline headings", () => {
		const incidental = `${body}\n\nExtra context.\n\n\nThe text mentions ## Tests and ## Blast radius as examples.`;
		expect(lintPrBody(incidental)).toMatchObject({ valid: true });
		expect(detectFlattenedBody(incidental)).toBe(false);
	});

	it("is idempotent", () => {
		const repaired = repairFlattenedBody(flattenedBody);
		expect(repairFlattenedBody(repaired)).toBe(repaired);
	});
});

describe("flattened body CI entrypoint", () => {
	afterEach(() => vi.unstubAllEnvs());

	function stubApi() {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	}

	it("patches only the repaired body and reports a notice", async () => {
		stubApi();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockImplementation(async (url: string, init?: RequestInit) => {
				if (String(url).includes("/files"))
					return new Response(
						JSON.stringify([{ filename: "tests/foo.test.ts" }]),
						{ status: 200 },
					);
				if (init?.method === "PATCH")
					return new Response("{}", { status: 200 });
				return new Response(JSON.stringify({ body: flattenedBody }), {
					status: 200,
				});
			});
		expect(
			await lintPullRequestEvent(fetchImpl, {
				pull_request: { number: 2144, body: flattenedBody },
			}),
		).toEqual({ valid: true, repaired: true });
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.example/repos/o/r/pulls/2144",
			expect.objectContaining({
				method: "PATCH",
				body: expect.stringContaining("## Tests\\n"),
			}),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("::notice::Repaired flattened PR body"),
		);
		log.mockRestore();
	});

	it("reports original errors and does not write when repair remains invalid", async () => {
		stubApi();
		const invalidFlattenedBody = flattenedBody.replace(
			"## Blast radius This change is test-only.",
			"## Blast radius",
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockImplementation(async (url: string) =>
			String(url).includes("/files")
				? new Response("[]", { status: 200 })
				: new Response(JSON.stringify({ body: invalidFlattenedBody }), {
						status: 200,
					}),
		);
		const result = await lintPullRequestEvent(fetchImpl, {
			pull_request: { number: 2144, body: invalidFlattenedBody },
		});
		expect(result).toMatchObject({ valid: false, repaired: false });
		expect(errors).toHaveBeenCalledWith(
			expect.stringContaining("PR body is missing a Summary section"),
		);
		expect(fetchImpl).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ method: "PATCH" }),
		);
		errors.mockRestore();
	});
});

describe("PR body lint (#1844)", () => {
	it("accepts the required sections", () => {
		expect(lintPrBody(body)).toEqual({ valid: true, errors: [] });
	});

	it.each(["Tests", "Blast radius", "Class sweep", "Observability"])(
		"rejects a missing %s section",
		(section) => {
			const result = lintPrBody(body.replace(`## ${section}\n`, ""));
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(`## ${section}`);
		},
	);

	it.each(["Tests", "Blast radius", "Class sweep", "Observability"])(
		"rejects an empty %s section",
		(section) => {
			const result = lintPrBody(
				body.replace(new RegExp(`## ${section}\\n[^#]*`), `## ${section}\n`),
			);
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toContain(`## ${section}`);
		},
	);

	it("accepts not applicable with a reason", () => {
		expect(
			lintPrBody(
				body.replace(
					"No runtime module touched.",
					"Not applicable: no runtime module changed.",
				),
			),
		).toMatchObject({ valid: true });
	});

	it("does not let Fix round headings satisfy required sections", () => {
		expect(
			lintPrBody("## Fix round 1\nOnly review history here."),
		).toMatchObject({
			valid: false,
		});
	});

	it("rejects the unfilled template", () => {
		const template = readFileSync(".github/PULL_REQUEST_TEMPLATE.md", "utf8");
		expect(lintPrBody(template)).toMatchObject({ valid: false });
	});

	it("accepts case-insensitive fleet synonyms", () => {
		expect(
			lintPrBody(
				"## WHAT CHANGED AND WHY\nReal summary.\n\n## verification\nRan tests.\n\n## BLAST RADIUS\nNone.\n\n## CLASS SWEEP\nDone.\n\n## OBSERVABILITY\nRecorded.",
			),
		).toMatchObject({ valid: true });
	});

	it("ignores fenced headings and fenced template instructions", () => {
		expect(lintPrBody("```md\n## Tests\nInstructions\n```\n")).toMatchObject({
			valid: false,
		});
	});

	it("counts a fenced red-run transcript as Tests content", () => {
		const transcript = body.replace(
			"Targeted tests pass.",
			"```text\nFAIL tests/scripts/check-pr-body.test.ts\n```",
		);
		expect(lintPrBody(transcript)).toMatchObject({ valid: true });
	});

	it("does not count a fenced heading as a required section", () => {
		expect(
			lintPrBody(
				"Summary\nOpening context.\n\n```md\n## Tests\nquoted heading\n```\n\n## Blast radius\nNone.\n\n## Class sweep\nDone.\n\n## Observability\nRecorded.",
			),
		).toMatchObject({ valid: false });
	});

	it.each([
		["unchecked", "- [ ] item", false],
		["checked", "- [x] item", true],
	])("handles %s-only sections", (_name, item, valid) => {
		const result = lintPrBody(body.replace("Targeted tests pass.", item));
		expect(result.valid).toBe(valid);
	});

	it("accepts H3 and H4 section headings", () => {
		const h3 = body.replaceAll("## ", "### ");
		expect(lintPrBody(h3)).toMatchObject({ valid: true });
	});

	it("keeps headings before an unterminated fence visible", () => {
		const unclosed = body + "\n\n```text\nunterminated transcript";
		expect(lintPrBody(unclosed)).toMatchObject({ valid: true });
	});

	it("guards null body input", () => {
		const result = lintPrBody(null as unknown as string);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"PR body is missing a Summary section. See .github/PULL_REQUEST_TEMPLATE.md.",
		);
	});

	it("accepts an opening paragraph instead of a Summary heading", () => {
		expect(
			lintPrBody(
				body.replace("Summary\nOpening context.\n\n", "Opening context.\n\n"),
			),
		).toMatchObject({ valid: true });
	});

	it("rejects a body with no Summary or opening paragraph", () => {
		expect(
			lintPrBody(body.replace("Summary\nOpening context.\n\n", "")),
		).toMatchObject({ valid: false });
	});
});

describe("live PR body resolution (#2085)", () => {
	const payloadPr = { number: 2085, body: "fallback" };

	afterEach(() => vi.unstubAllEnvs());

	it("uses the live body and API URL", async () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ body: "live" }), { status: 200 }),
			);
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toBe("live");
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/2085",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it.each([
		[
			"non-2xx",
			new Response("denied", { status: 403 }),
			"GitHub API returned 403",
		],
		[
			"malformed shape",
			new Response(JSON.stringify({ body: 42 }), { status: 200 }),
			"no body",
		],
	])("falls back and warns for %s", async (_name, response, reason) => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(response);
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toBe("fallback");
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining(reason));
		warning.mockRestore();
	});

	it("falls back without a token and does not fetch", async () => {
		vi.stubEnv("GITHUB_TOKEN", "");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn();
		expect(await resolveLivePrBody(payloadPr, fetchImpl)).toBe("fallback");
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("GITHUB_TOKEN is not set"),
		);
		warning.mockRestore();
	});
});

describe("conditional Test assessment section (value discipline)", () => {
	const assessed = `${body}

### Test assessment
foo.test.ts uniquely pins the retry ladder; nothing made redundant.`;

	it("does not require the section by default", () => {
		expect(lintPrBody(body)).toMatchObject({ valid: true });
	});

	it("requires the section when the PR touches tests/", () => {
		const result = lintPrBody(body, { requireTestAssessment: true });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});

	it("accepts an answered section when required", () => {
		expect(lintPrBody(assessed, { requireTestAssessment: true })).toMatchObject(
			{ valid: true },
		);
	});

	it("rejects an empty section when required", () => {
		const result = lintPrBody(
			`${body}

### Test assessment
`,
			{
				requireTestAssessment: true,
			},
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});

	it("rejects the template placeholder as content", () => {
		const template = readFileSync(".github/PULL_REQUEST_TEMPLATE.md", "utf8");
		const placeholder =
			/### Test assessment\r?\n\r?\n([^#]*)/.exec(template)?.[1] ?? "";
		expect(placeholder.trim().length).toBeGreaterThan(0);
		const result = lintPrBody(
			`${body}

### Test assessment
${placeholder}`,
			{ requireTestAssessment: true },
		);
		expect(result.valid).toBe(false);
	});
});

describe("resolveTouchesTests", () => {
	const payloadPr = { number: 7, body: "fallback" };

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("returns true when a tests/ file is in the list", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify([
						{ filename: "clients/foo.ts" },
						{ filename: "tests/clients/foo.test.ts" },
					]),
					{ status: 200 },
				),
			);
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(true);
	});

	it("returns false for a production-only PR", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify([{ filename: "clients/foo.ts" }]), {
				status: 200,
			}),
		);
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(false);
	});

	it("returns null and warns when the list is paginated", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response("[]", {
				status: 200,
				headers: { link: '<next>; rel="next"' },
			}),
		);
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(null);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		warning.mockRestore();
	});

	it("returns null and warns on a fetch failure", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("boom", { status: 500 }));
		expect(await resolveTouchesTests(payloadPr, fetchImpl)).toBe(null);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("::warning::"),
		);
		warning.mockRestore();
	});
});

describe("nested headings are structure, not content (#2124 F1)", () => {
	it("still flags an empty Tests section that carries only the nested heading", () => {
		const result = lintPrBody(
			body.replace(
				"## Tests\nTargeted tests pass.",
				"## Tests\n### Test assessment",
			),
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("## Tests");
	});

	it("rejects a required Test assessment satisfied only by a deeper heading", () => {
		const result = lintPrBody(
			`${body}

### Test assessment
#### sub`,
			{
				requireTestAssessment: true,
			},
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});
});

describe("renames out of tests/ still require the assessment (#2124 F3)", () => {
	it("counts previous_filename", async () => {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify([
					{
						filename: "attic/foo.test.ts",
						previous_filename: "tests/clients/foo.test.ts",
					},
				]),
				{ status: 200 },
			),
		);
		expect(await resolveTouchesTests({ number: 7 }, fetchImpl)).toBe(true);
		vi.unstubAllEnvs();
	});
});

describe("the entrypoint consumes the tri-state (#2124 F2)", () => {
	const assessedBody = `${body}

### Test assessment
foo.test.ts uniquely pins the retry ladder.`;

	afterEach(() => vi.unstubAllEnvs());

	function fetchFor(bodyText: string, files: unknown) {
		return vi.fn().mockImplementation(async (url: string | URL | Request) => {
			if (String(url).includes("/files"))
				return files instanceof Error
					? Promise.reject(files)
					: new Response(JSON.stringify(files), { status: 200 });
			return new Response(JSON.stringify({ body: bodyText }), { status: 200 });
		});
	}

	function stubApi() {
		vi.stubEnv("GITHUB_TOKEN", "t");
		vi.stubEnv("GITHUB_API_URL", "https://api.example");
		vi.stubEnv("GITHUB_REPOSITORY", "o/r");
	}

	it("requires the section when the live file list touches tests/", async () => {
		stubApi();
		const result = await lintLivePrBody(
			{ number: 7, body },
			fetchFor(body, [{ filename: "tests/clients/foo.test.ts" }]),
		);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("Test assessment");
	});

	it("accepts the assessed body when required", async () => {
		stubApi();
		const result = await lintLivePrBody(
			{ number: 7, body: assessedBody },
			fetchFor(assessedBody, [{ filename: "tests/clients/foo.test.ts" }]),
		);
		expect(result).toMatchObject({ valid: true });
	});

	it("skips the section for production-only PRs", async () => {
		stubApi();
		const result = await lintLivePrBody(
			{ number: 7, body },
			fetchFor(body, [{ filename: "clients/foo.ts" }]),
		);
		expect(result).toMatchObject({ valid: true });
	});

	it("skips the section on file-list fetch trouble (null never enforces)", async () => {
		stubApi();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await lintLivePrBody(
			{ number: 7, body },
			fetchFor(body, new Error("boom")),
		);
		expect(result).toMatchObject({ valid: true });
		warning.mockRestore();
	});
});
