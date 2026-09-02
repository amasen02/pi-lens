/**
 * One production-faithful double for `clients/bootstrap.ts`'s module shape
 * (#2467).
 *
 * Thirty-odd `vi.mock("…/bootstrap.js")` factories used to return a single
 * `loadBootstrapClients` key. That was enough while the module exported one
 * accessor; it is not enough now that `index.ts` and `clients/runtime-tool-call.ts`
 * consume the on-demand seam as well, and a named import of a key the factory
 * omits fails at link time rather than at the assertion that cares. Worse, a
 * factory that supplied `loadBootstrapClients` alone while production had
 * moved to `requestBootstrapClients` would be the inert double AGENTS.md keeps
 * catching: green, and testing nothing.
 *
 * So the module shape lives here once. A new bootstrap export lands in every
 * mock at the same moment instead of being discovered one red suite at a time.
 *
 * Fidelity on the axis these tests exercise:
 *
 * - `requestBootstrapClients` resolves through the SAME loader as
 *   `loadBootstrapClients`, so a test cannot pass because the fail-open path
 *   quietly returned a different (or absent) client set.
 * - `peekBootstrapClients` answers `null` until a load has actually completed,
 *   exactly as production does — a peek that pretended the clients were
 *   already resident would hide the very laziness this issue introduced.
 */

/** The module shape a `vi.mock` factory for `clients/bootstrap.js` must return. */
export interface BootstrapSeamMock {
	loadBootstrapClients: () => Promise<unknown>;
	requestBootstrapClients: (options?: unknown) => Promise<unknown>;
	peekBootstrapClients: () => unknown;
	markAnalyzerBootstrapShutdown: () => void;
	resetAnalyzerBootstrapSessionState: () => void;
	degradedClient: () => unknown;
	BOOTSTRAP_LOAD_TIMEOUT_MS: number;
}

/**
 * Build the module double from the loader a call site already wrote.
 *
 * Pass the existing `async () => ({ …clients })` arrow unchanged; everything
 * else is derived from it.
 */
export function bootstrapSeamMock(
	load: () => Promise<unknown>,
): BootstrapSeamMock {
	let resident: unknown = null;
	const loadOnce = async (): Promise<unknown> => {
		const clients = await load();
		resident = clients;
		return clients;
	};
	return {
		loadBootstrapClients: loadOnce,
		requestBootstrapClients: () => loadOnce(),
		peekBootstrapClients: () => resident,
		markAnalyzerBootstrapShutdown: () => {},
		resetAnalyzerBootstrapSessionState: () => {},
		degradedClient: () => ({}),
		BOOTSTRAP_LOAD_TIMEOUT_MS: 10_000,
	};
}
