import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";
const TEMPLATE_FILE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	TEMPLATE_PATH,
);
const REQUIRED_SECTIONS = [
	"Tests",
	"Blast radius",
	"Class sweep",
	"Observability",
];
const HEADING = /^#{2,4}\s+(.+?)\s*$/;
const FLATTENED_BODY_MAX_NEWLINES = 2;
const REPAIR_HEADINGS = [
	"Summary",
	"Tests",
	"Test assessment",
	"Blast radius",
	"Class sweep",
	"Observability",
	"Fix round \\d+",
	"Review round \\d+",
];
const REPAIR_HEADING_PATTERN = REPAIR_HEADINGS.join("|");
const CORRUPTED_HEADING_TAILS = [
	"ummary",
	"ests",
	"est assessment",
	"last radius",
	"lass sweep",
	"bservability",
	"ix round \\d+",
	"eview round \\d+",
];
const CORRUPTED_IDENTIFIER_TAILS = ["etchOpenPullRequests", "px"];

// Fleet census from the review of 11 bodies: ## OBSERVABILITY x5,
// ## what changed x6, ## verification x7, and ## Summary x1. “What changed”
// (with or without “and why”) satisfies Summary; “Verification” satisfies
// Tests. Heading matching is deliberately case-insensitive.
const SECTION_SYNONYMS = new Map([
	["summary", "summary"],
	["problem", "summary"],
	["what changed", "summary"],
	["what changed and why", "summary"],
	["what changed / why", "summary"],
	["what changed / why / verification", ["summary", "tests"]],
	["tests", "tests"],
	["verification", "tests"],
	["blast radius", "blast radius"],
	["class sweep", "class sweep"],
	["observability", "observability"],
	["test assessment", "test assessment"],
]);

function sectionMessage(name, detail) {
	return `PR body ${detail} "## ${name}". See ${TEMPLATE_PATH}.`;
}

function hasSection(heading, section) {
	return Array.isArray(heading?.section)
		? heading.section.includes(section)
		: heading?.section === section;
}

function sourceWithoutFencedBlocks(source) {
	let fenced = false;
	return String(source ?? "")
		.split(/\r?\n/)
		.map((line) => {
			if (/^\s*```/.test(line)) {
				fenced = !fenced;
				return "";
			}
			return fenced ? "" : line;
		})
		.join("\n");
}

function templatePlaceholderLines() {
	const lines = sourceWithoutFencedBlocks(
		readFileSync(TEMPLATE_FILE, "utf8"),
	).split(/\r?\n/);
	const placeholders = new Map();
	let current;
	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading) {
			current = SECTION_SYNONYMS.get(heading[1].trim().toLowerCase());
			continue;
		}
		const value = line.trim();
		// Exact placeholder matching is intentionally advisory: paste-and-tweak
		// residuals can evade it when a contributor changes one word.
		if (current && value && !/^[-*+] \[ \]/.test(value)) {
			if (!placeholders.has(current)) placeholders.set(current, new Set());
			placeholders.get(current).add(value);
		}
	}
	return placeholders;
}

function hasRealContent(lines, section, placeholders) {
	const templateLines = placeholders.get(section) ?? new Set();
	return lines.some((line) => {
		const value = line.trim();
		// A nested heading is structure, not content: counting it let an empty
		// "## Tests" pass on the strength of its own "### Test assessment" line
		// (#2124 review F1).
		return (
			value &&
			!HEADING.test(value) &&
			!/^[-*+] \[ \]/.test(value) &&
			!templateLines.has(value)
		);
	});
}

/** Detect the high-confidence shape produced when a worker flattens a body. */
export function detectFlattenedBody(body = "") {
	const source = String(body ?? "");
	const newlineCount = (source.match(/\r?\n/g) ?? []).length;
	if (newlineCount > FLATTENED_BODY_MAX_NEWLINES || source.length < 200)
		return false;
	// A flattened body containing these markers has already lost data. It is
	// safer to report the original lint errors than to write a guessed repair.
	if (
		/[\f\t]|\r(?!\n)|\\[ftr]/.test(source) ||
		/\\n/.test(source) ||
		new RegExp(
			`(?:^|[\\s])(?:${CORRUPTED_HEADING_TAILS.join("|")})(?=\\s|$)`,
			"i",
		).test(source) ||
		new RegExp(
			`(?:^|[\\s` +
				"\\\"'" +
				`])(?:${CORRUPTED_IDENTIFIER_TAILS.join("|")})(?=$|[\\s` +
				"\\\"',.)" +
				`])`,
		).test(source)
	)
		return false;
	const inlineHeadings = source.match(
		new RegExp(
			`(?<!^)\\s#{2,4}\\s+(?:${REPAIR_HEADING_PATTERN})(?=\\s|$)`,
			"g",
		),
	);
	return (inlineHeadings?.length ?? 0) >= 2;
}

/** Repair only a body already proven to have the flattened shape. */
export function repairFlattenedBody(body = "") {
	const source = String(body ?? "");
	if (!detectFlattenedBody(source)) return source;
	let repaired = source.replace(/\r\n?/g, "\n");
	repaired = repaired.replace(
		new RegExp(
			`(^|[.!?])[ \\t]*(#{2,4}\\s+(?:${REPAIR_HEADING_PATTERN}))(?=\\s|$)`,
			"g",
		),
		(_match, sentenceEnd, heading) =>
			sentenceEnd ? `${sentenceEnd}\n\n${heading}\n` : `${heading}\n`,
	);
	const residualInlineHeadings = repaired.match(
		new RegExp(
			`(?<!^)[ \\t]#{2,4}\\s+(?:${REPAIR_HEADING_PATTERN})(?=\\s|$)`,
			"g",
		),
	);
	if (residualInlineHeadings?.length) return source;
	const repairedHeadings = repaired
		.split("\n")
		.map((line) => HEADING.exec(line)?.[1].trim().toLowerCase())
		.filter(Boolean);
	const templateHeadings = repairedHeadings.filter((heading) =>
		new RegExp(`^(?:${REPAIR_HEADING_PATTERN})$`, "i").test(heading),
	);
	const distinctTemplateHeadings = new Set(
		templateHeadings.map((heading) => heading.replace(/ \d+$/, "")),
	);
	if (repairedHeadings.length !== distinctTemplateHeadings.size) return source;
	return repaired;
}

/** Check the structural PR-body contract, including answered sections. */
export function lintPrBody(body = "", options = {}) {
	const rawLines = String(body ?? "").split(/\r?\n/);
	const lines = sourceWithoutFencedBlocks(body).split(/\r?\n/);
	const headings = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = HEADING.exec(lines[index]);
		if (match)
			headings.push({
				index,
				name: match[1],
				level: match[0].match(/^#+/)[0].length,
				section: SECTION_SYNONYMS.get(match[1].trim().toLowerCase()),
			});
	}
	const placeholders = templatePlaceholderLines();
	const errors = [];
	const summary = headings.find((heading) => hasSection(heading, "summary"));
	const firstHeading = headings[0]?.index ?? lines.length;
	const nextSectionHeading = (heading) =>
		headings.find(
			(candidate) =>
				candidate.index > heading.index && candidate.level <= heading.level,
		);
	const summaryEnd = summary
		? (nextSectionHeading(summary)?.index ?? lines.length)
		: 0;
	if (
		(!summary ||
			!hasRealContent(
				lines.slice(summary.index + 1, summaryEnd),
				"summary",
				placeholders,
			)) &&
		!hasRealContent(lines.slice(0, firstHeading), "summary", placeholders)
	) {
		errors.push(`PR body is missing a Summary section. See ${TEMPLATE_PATH}.`);
	}

	// Value discipline (AGENTS.md "Test assessment and removal"): a PR that
	// touches tests/ must say, per touched file, what it uniquely pins and
	// what became redundant. Conditional because docs/production-only PRs owe
	// nothing here.
	const requiredSections = options.requireTestAssessment
		? [...REQUIRED_SECTIONS, "Test assessment"]
		: REQUIRED_SECTIONS;

	for (const name of requiredSections) {
		const heading = headings.find((candidate) =>
			hasSection(candidate, name.toLowerCase()),
		);
		if (!heading) {
			errors.push(sectionMessage(name, "is missing"));
			continue;
		}
		const nextHeading = nextSectionHeading(heading);
		const rawContent = rawLines.slice(
			heading.index + 1,
			nextHeading?.index ?? lines.length,
		);
		if (!hasRealContent(rawContent, name.toLowerCase(), placeholders))
			errors.push(
				sectionMessage(name, "has no content before the next heading"),
			);
	}
	return { valid: errors.length === 0, errors };
}

async function fetchLivePrBody(payloadPr, fetchImpl) {
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	const apiUrl = process.env.GITHUB_API_URL;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!apiUrl || !repository)
		throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
	const response = await fetchImpl(
		`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}`,
		{
			signal: AbortSignal.timeout(10_000),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);
	if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
	const data = await response.json();
	if (typeof data.body !== "string")
		throw new Error("GitHub API returned no body");
	return data.body;
}

export async function resolveLivePrBody(
	payloadPr,
	fetchImpl = globalThis.fetch,
) {
	try {
		return await fetchLivePrBody(payloadPr, fetchImpl);
	} catch (error) {
		console.warn(
			`::warning::Could not fetch the live PR body; using the event payload instead (${error instanceof Error ? error.message : error}).`,
		);
		return payloadPr.body ?? "";
	}
}

export async function patchLivePrBody(
	payloadPr,
	body,
	fetchImpl = globalThis.fetch,
) {
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	const apiUrl = process.env.GITHUB_API_URL;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!apiUrl || !repository)
		throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
	const response = await fetchImpl(
		`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}`,
		{
			method: "PATCH",
			signal: AbortSignal.timeout(10_000),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ body }),
		},
	);
	if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
}

/**
 * True when the PR touches any file under tests/. Advisory best-effort: one
 * page of 100 files covers this repo's PR sizes; on any failure (including a
 * PR larger than the page, detected via the Link header) return null so the
 * caller SKIPS the conditional check rather than guessing — a lint that can
 * misfire on fetch trouble teaches people to ignore it.
 */
export async function resolveTouchesTests(
	payloadPr,
	fetchImpl = globalThis.fetch,
) {
	try {
		const token = process.env.GITHUB_TOKEN;
		if (!token) throw new Error("GITHUB_TOKEN is not set");
		const apiUrl = process.env.GITHUB_API_URL;
		const repository = process.env.GITHUB_REPOSITORY;
		if (!apiUrl || !repository)
			throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
		const response = await fetchImpl(
			`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}/files?per_page=100`,
			{
				signal: AbortSignal.timeout(10_000),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
		if (/rel="next"/.test(response.headers.get("link") ?? ""))
			throw new Error(
				"PR exceeds one file page; skipping the conditional check",
			);
		const files = await response.json();
		if (!Array.isArray(files))
			throw new Error("GitHub API returned no file list");
		return files.some(
			(file) =>
				/^tests\//.test(file.filename ?? "") ||
				// A rename OUT of tests/ reports only the new path in filename; a
				// removal PR is exactly what the assessment exists to catch.
				/^tests\//.test(file.previous_filename ?? ""),
		);
	} catch (error) {
		console.warn(
			`::warning::Could not resolve the PR file list; skipping the Test assessment check (${error instanceof Error ? error.message : error}).`,
		);
		return null;
	}
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

/**
 * The full live lint: resolve body and file list, then lint. The tri-state
 * from resolveTouchesTests is consumed HERE: only an affirmative true
 * requires the Test assessment section — null (fetch trouble) and false
 * (no tests/ files) both skip it, so a flaky fetch can never misfire the
 * check (#2124 review F2 pinned this consumption).
 */
export async function lintPullRequestEvent(
	fetchImpl = globalThis.fetch,
	event = eventPayload(),
) {
	const pullRequest = event.pull_request;
	if (!pullRequest || !process.env.GITHUB_REPOSITORY)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");
	const body = await resolveLivePrBody(pullRequest, fetchImpl);
	const requireTestAssessment =
		(await resolveTouchesTests(pullRequest, fetchImpl)) === true;
	const result = lintPrBody(body, { requireTestAssessment });
	if (result.valid) {
		console.log(`PR body OK: ${pullRequest.number}`);
		return { valid: true, repaired: false };
	}
	if (detectFlattenedBody(body)) {
		const repairedBody = repairFlattenedBody(body);
		const repairedResult = lintPrBody(repairedBody, { requireTestAssessment });
		if (repairedResult.valid) {
			try {
				const latestBody = await fetchLivePrBody(pullRequest, fetchImpl);
				if (latestBody !== body) {
					console.log(
						`::notice::Skipped flattened PR body repair for #${pullRequest.number}; the body changed during linting.`,
					);
					for (const error of result.errors) console.error(error);
					return { valid: false, repaired: false };
				}
				await patchLivePrBody(pullRequest, repairedBody, fetchImpl);
				console.log(
					`::notice::Repaired flattened PR body for #${pullRequest.number} before validation passed.`,
				);
				return { valid: true, repaired: true };
			} catch (error) {
				console.warn(
					`::warning::Skipped flattened PR body repair for #${pullRequest.number}; freshness check failed, preserving original lint errors (${error instanceof Error ? error.message : error}).`,
				);
			}
		}
	}
	for (const error of result.errors) console.error(error);
	return { valid: false, repaired: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	lintPullRequestEvent()
		.then((result) => {
			if (!result.valid) process.exitCode = 1;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
