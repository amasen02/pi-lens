/**
 * effective_config pi tool (#2427) — the in-process half of
 * `pilens_effective_config`.
 *
 * A thin wrapper over the `effectiveConfig()` engine seam
 * (`clients/lens-engine.ts`), like `tools/symbol-search.ts` over
 * `symbolSearch()`: the payload is byte-identical to the MCP mirror's because
 * both render the SAME view object, and neither adapter shapes it. The whole
 * reason the capability is an engine method rather than an MCP handler is that
 * a second projection would be a second chance to disagree about which server
 * is running.
 */

import { Type } from "../clients/deps/typebox.js";
import {
	effectiveConfig,
	type EffectiveConfigView,
	isEffectiveFileViewError,
} from "../clients/lens-engine.js";
import { compactRenderResult } from "./render-compact.js";

/** One line per decision, for the compact renderer. */
function summarize(view: EffectiveConfigView): string {
	const documents = `${view.documents.length} config file(s)`;
	if (!view.file) return `effective_config — ${documents}`;
	if (isEffectiveFileViewError(view.file)) {
		return `effective_config — ${documents} · ${view.file.error}`;
	}
	const selected = view.file.servers.filter((entry) => entry.selected).length;
	const denied = view.file.servers.filter(
		(entry) => entry.reason === "disabled-by-config",
	).length;
	const tools = view.file.tools.filter((entry) => entry.selected).length;
	// The denial clause is built first rather than nested inside the summary
	// template: a conditional expression inside a template inside a template is
	// the S3358/nested-template shape SonarCloud flags, and it hid the one
	// number a reader is looking for (#2427 review round 2, F3).
	const deniedClause = denied > 0 ? `, ${denied} denied by config` : "";
	return (
		`effective_config ${view.file.path} — ${documents} · ` +
		`${selected} server(s) selected${deniedClause} · ` +
		`${tools} tool(s)`
	);
}

export function createEffectiveConfigTool(getProjectRoot: () => string) {
	return {
		name: "effective_config" as const,
		label: "Effective Config",
		description:
			"The resolved pi-lens configuration with the provenance of every decision — which file and tier each setting came from, and the trust decision that applied. Pass `file` to also get, for that path, its language, every LSP server with the reason it was selected or denied (including which tier's config denied it, which a nearer file cannot lift), and the lint/format runners that would dispatch. Answers 'why is X running/selected' without reading logs. Redacted by construction: it reports sources, never values — no env values, no command arguments beyond the binary, and config paths are home-relative.",
		promptSnippet:
			"Resolved config + provenance — why a server or tool is selected",
		renderResult: compactRenderResult<{ summary?: string }>(
			({ details, isError }) =>
				isError
					? "effective_config — failed"
					: (details?.summary ?? "effective_config"),
		),
		parameters: Type.Object({
			file: Type.Optional(
				Type.String({
					description:
						"Path to explain: adds the resolved language plus the per-server and per-runner selection decisions for it.",
				}),
			),
		}),
		async execute(
			_toolCallId: string,
			params: { file?: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: { cwd?: string },
		) {
			const cwd = getProjectRoot() || ctx.cwd || ".";
			const view = await effectiveConfig({
				cwd,
				...(params.file === undefined ? {} : { file: params.file }),
				redact: true,
			});
			const summary = summarize(view);
			return {
				content: [
					{
						type: "text" as const,
						text: `${summary}\n\n${JSON.stringify(view)}`,
					},
				],
				// Summary-shaped, like `symbol_search`'s: the full view is already
				// in `content[0].text`, and `details` exists for the renderer.
				// Duplicating a whole provenance dump into it would double the
				// payload of every call for one line of output.
				details: {
					summary,
					documents: view.documents.length,
					provenance: view.provenance.length,
					...(view.file === undefined
						? {}
						: isEffectiveFileViewError(view.file)
							? { fileError: view.file.error }
							: {
									file: view.file.path,
									selectedServers: view.file.servers.filter(
										(entry) => entry.selected,
									).length,
								}),
				},
			};
		},
	};
}
