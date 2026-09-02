// Type declarations for prune-agent-worktrees.mjs (untyped .mjs imported
// from .ts tests). Only the pure, exported seams are declared — the CLI body
// is not importable surface.

import type { ProcRow } from "./lib/worktree-hygiene.d.mts";

export const DEFAULT_HOOK_BUDGET_MS: number;
export const DEFAULT_MANUAL_BUDGET_MS: number;
export const DEFAULT_SCAN_TIMEOUT_MS: number;
export const MIN_SCAN_BUDGET_MS: number;
export const DEFAULT_GIT_TIMEOUT_MS: number;
export const MIN_GIT_TIMEOUT_MS: number;
export const REMOVE_TIMEOUT_MS: number;

export interface PruneCliOptions {
	dryRun: boolean;
	minAgeMs: number;
	budgetMs: number | null;
	only: string[] | null;
	hook: string | null;
	orphanSweep: boolean;
	json: boolean;
	quiet: boolean;
	help: boolean;
	errors: string[];
}

export function parseArgs(argv: string[]): PruneCliOptions;

export interface HookPolicy {
	removeWorktrees: boolean;
	deleteBranches: boolean;
	orphanSweep: boolean;
	scopedToAgentTree: boolean;
	maxRemovals: number | null;
}

export const HOOK_POLICIES: Readonly<Record<string, HookPolicy>>;

export function resolveHookPolicy(hook: string | null | undefined): HookPolicy;

export function worktreePathFromHookPayload(
	payload: unknown,
	repoRoot: string,
): string | null;

export function parseProcessTable(
	out: string,
	tabSeparated: boolean,
): ProcRow[];

export function getHygieneLogPath(): string;
