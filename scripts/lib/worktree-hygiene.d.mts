// Type declarations for worktree-hygiene.mjs (untyped .mjs imported from .ts
// tests). Mirrors the JSDoc in the implementation; keep the two in sync.

export const DEFAULT_MIN_AGE_MS: number;
export const DEFAULT_LOG_MAX_LINES: number;
export const MAX_RECORDED_COMMAND_CHARS: number;
export const AGENT_WORKTREE_SEGMENT: string;
export const FIXTURE_HELPER_MARKERS: string[];

export interface WorktreeListRow {
	path: string;
	head: string | null;
	branch: string | null;
	detached: boolean;
	bare: boolean;
	locked: boolean;
	lockedReason: string | null;
	prunable: boolean;
}

export interface WorktreeCandidate {
	path: string;
	head?: string | null;
	branch?: string | null;
	dirty: boolean;
	pushed: boolean;
	mtimeMs: number;
	locked?: boolean;
	lockPid?: number | null;
	unevaluated?: boolean;
}

export interface PrunePlanRemoval {
	path: string;
	branch: string | null;
	ageMs: number;
	locked: boolean;
	selected: boolean;
}

export interface PrunePlanKeep {
	path: string;
	reason: string;
	detail: string | null;
}

export interface PrunePlan {
	remove: PrunePlanRemoval[];
	keep: PrunePlanKeep[];
}

export interface ProcRow {
	pid: number;
	ppid?: number;
	command: string;
	cwd?: string;
}

export function toComparablePath(p: string): string;
export function toComparableText(text: string): string;
export function isAgentWorktreePath(p: string): boolean;
export function parseWorktreeList(porcelain: string): WorktreeListRow[];
export function parseLockPid(
	lockedReason: string | null | undefined,
): number | null;
export function parseDuration(text: string): number | null;

export function planWorktreePrune(options: {
	worktrees: WorktreeCandidate[];
	nowMs: number;
	minAgeMs?: number;
	only?: string[] | null;
	selfPath?: string | string[] | null;
	isPidAlive?: (pid: number) => boolean;
}): PrunePlan;

export function orderBySelection<T extends { path: string }>(
	rows: T[],
	only: string[] | null,
): T[];

export function isFixtureHelperCommand(command: string): boolean;

export function collectAncestorPids(
	rows: ProcRow[],
	startPid: number,
): Set<number>;

export function selectProcessesUnderPath(
	rows: ProcRow[],
	targetPath: string,
	options?: { protectedPids?: Set<number> },
): ProcRow[];

export function selectOrphanFixtureProcesses(
	rows: ProcRow[],
	options?: { selfPid?: number; protectedPids?: Set<number> },
): { row: ProcRow; reason: string }[];

export const AGENT_BRANCH_SHAPES: RegExp[];

// `containedInOrigin` is accepted but deliberately UNUSED: callers hand the
// same row shape to both this pre-filter and selectStaleBranches, and the
// point of the split is that the cheap half never consults containment.
export function isAgentBranchCandidate(branch: {
	name: string;
	hasUpstream: boolean;
	upstreamGone: boolean;
	checkedOut: boolean;
	containedInOrigin?: boolean;
}): boolean;

export function selectStaleBranches(
	branches: {
		name: string;
		containedInOrigin: boolean;
		hasUpstream: boolean;
		upstreamGone: boolean;
		checkedOut: boolean;
	}[],
): string[];

export function formatKillRecord(input: {
	pid: number;
	command: string;
	reason: string;
	worktree?: string | null;
	dryRun?: boolean;
	killed?: boolean;
	error?: string | null;
	nowIso?: string;
}): string;

export function formatWorktreeRecord(input: {
	path: string;
	branch?: string | null;
	ageMs: number;
	dryRun?: boolean;
	removed?: boolean;
	error?: string | null;
	nowIso?: string;
}): string;

export function formatScanRecord(input: {
	reason: "skipped" | "empty";
	budgetMs: number;
	remainingMs?: number;
	rows?: number;
	nowIso?: string;
}): string;

export function pruneLogLines(
	existingLines: string[],
	newLines: string[],
	maxLines?: number,
): string[];
