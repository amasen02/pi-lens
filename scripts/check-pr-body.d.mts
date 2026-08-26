export declare function detectFlattenedBody(body?: string): boolean;
export declare function repairFlattenedBody(body?: string): string;
export declare function lintPrBody(
	body?: string,
	options?: { requireTestAssessment?: boolean },
): {
	valid: boolean;
	errors: string[];
};
export declare function resolveLivePrBody(
	payloadPr: { number: number; body?: string | null },
	fetchImpl?: typeof fetch,
): Promise<string>;
export declare function patchLivePrBody(
	payloadPr: { number: number },
	body: string,
	fetchImpl?: typeof fetch,
): Promise<void>;
export declare function resolveTouchesTests(
	payloadPr: { number: number },
	fetchImpl?: typeof fetch,
): Promise<boolean | null>;
export declare function lintPullRequestEvent(
	fetchImpl?: typeof fetch,
	event?: { pull_request?: { number: number; body?: string | null } },
): Promise<{ valid: boolean; repaired: boolean }>;
