// Type declarations for process-scan.mjs (untyped .mjs imported from .ts tests).

export const LSP_PROCESS_MARKERS: string[];

export interface ProcessRow {
	pid: number;
	command: string;
}

export function isLspServerCommand(command: string): boolean;

export function diffSurvivingLspProcesses(
	before: ProcessRow[],
	after: ProcessRow[],
): ProcessRow[];

export type ProcessField = "pid" | "ppid" | "command";

export interface ProcRow {
	pid: number;
	ppid: number;
	command: string;
	cwd?: string;
}

export const DEFAULT_SNAPSHOT_TIMEOUT_MS: number;
export const ALL_PROCESS_FIELDS: readonly ProcessField[];

export function windowsExe(name: string): string;

export function posixPsPath(): string;

export function normalizeProcessFields(
	fields: readonly ProcessField[] | null | undefined,
): ProcessField[];

export function parseProcessTable(
	out: string,
	tabSeparated: boolean,
	fields?: readonly ProcessField[],
): ProcRow[];

export function snapshotProcesses(
	fields?: readonly ProcessField[],
	timeoutMs?: number,
): Promise<{ rows: ProcRow[]; ok: boolean }>;

export interface ProcessSnapshot {
	rows: ProcessRow[];
	ok: boolean;
}

export function evaluateNoSurvivingLspProcesses(
	before: ProcessSnapshot,
	after: ProcessSnapshot,
): { id: string; pass: boolean; detail: string };
