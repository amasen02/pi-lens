export declare const REQUIRED_CHECKS: string[];
export declare const EXIT_SUCCESS: number;
export declare const EXIT_FAILURE: number;
export declare const EXIT_DIRTY: number;
export declare const EXIT_PENDING: number;
export declare const POLL_INTERVAL_SECONDS: number;
export declare const HARD_CAP_SECONDS: number;

export declare function isPrNumber(arg: unknown): boolean;

export interface VerdictRow {
	name: string;
	present: boolean;
	status: string | null;
	conclusion: string | null;
	url: string | null;
}

export interface Verdict {
	exitCode: number;
	rows: VerdictRow[];
	reason: string;
}

export declare function computeVerdict(
	checkRunsPayload: { check_runs?: unknown[] } | null | undefined,
	requiredChecks?: string[],
): Verdict;

export declare function formatVerdictTable(rows: VerdictRow[]): string;

export declare function resolveWaitCapSeconds(
	waitSecondsArg: number | null,
): number;

export declare function pollVerdict(args: {
	fetchPayload: () => Promise<{ check_runs?: unknown[] } | null | undefined>;
	waitSeconds: number | null;
	sleepImpl?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<{ verdict: Verdict; polls: number }>;

export declare function resolveRepository(
	ghExec?: (args: string[]) => string,
): string;

export declare function resolveHeadSha(
	target: string,
	ghExec?: (args: string[]) => string,
): string;

export declare function fetchCheckRunsPayload(
	repository: string,
	sha: string,
	ghExec?: (args: string[]) => string,
): { check_runs?: unknown[] };

export declare function parseArgs(argv: string[]): {
	target: string | null;
	waitSeconds: number | null;
};
