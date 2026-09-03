export declare const REQUIRED_CHECKS: string[];

export interface CheckRunRecord {
	name: string;
	status?: string | null;
	conclusion?: string | null;
	startedAt?: string | null;
	started_at?: string | null;
	[key: string]: unknown;
}

export declare function preferCheckRun<T extends CheckRunRecord>(a: T, b: T): T;

export declare function resolveLatestByName<T extends CheckRunRecord>(
	checkRuns: T[] | null | undefined,
): Map<string, T>;
