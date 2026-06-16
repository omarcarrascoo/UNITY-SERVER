/**
 * The serializable contract for delegating a scoped task to the Dev Squad.
 *
 * This is the ONLY shape that crosses the A2A wire between `core` (PM) and the
 * `dev-squad` process. It MUST stay plain-JSON: no object refs, no class
 * instances, no handles reached through it. `delegation.ts` is the single
 * encoder/parser so the boundary is auditable (design §14 "non-serializable
 * leakage" mitigation).
 *
 * The Dev Squad is stateless: it gets everything it needs to run the pipeline
 * here, works against `repoPath` on the shared filesystem, and returns metadata.
 * It never receives `runId`/`taskId` for LLM calls — passing those would trigger
 * telemetry/token-tracking SQLite writes, which only `core` is allowed to do.
 */
import { randomUUID } from 'crypto';
import type { Message } from '@a2a-js/sdk';

/** Payload PM → Dev Squad. All fields JSON-serializable. */
export interface DelegationPayload {
  /** Absolute path to the task's git worktree on the shared filesystem. */
  repoPath: string;
  /** Fully-built, scoped instruction for the implementer (already includes contract + deps). */
  userPrompt: string;
  /** Repo-root-relative paths the task may write. */
  writeScope: string[];
  /** Project tree snapshot (so the squad needn't rescan if core already has it). */
  projectTree: string;
  /** .unityrc.md contents, or null. */
  projectMemory: string | null;
  /** Figma context string, or null. */
  figmaData: string | null;
  /** Learned-pattern guidance block, or null. */
  learnedPatterns: string | null;
  /** Baseline gate failures the squad must NOT try to fix, or null. */
  baselineFailures: string | null;
  /** Project name — for the Explorer's knowledge-graph READ only (no writes). */
  projectName: string;
  /** Run/task ids for correlation/logging ONLY — never forwarded to LLM calls. */
  correlationRunId: string;
  correlationTaskId: string;
}

/** Result Dev Squad → PM. All fields JSON-serializable. */
export interface DelegationResult {
  targetRoute: string;
  commitMessage: string;
  tokenUsage: number;
  iterations: number;
  filesRead: string[];
  toolHistory: string[];
}

/** Encode a delegation as an A2A user Message (single JSON text part). */
export function encodeDelegation(payload: DelegationPayload): Message {
  return {
    kind: 'message',
    messageId: randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text: JSON.stringify(payload) }],
  };
}

/** Parse a delegation from an inbound A2A Message. Throws if malformed. */
export function parseDelegation(message: Message): DelegationPayload {
  const text = message.parts.find((p) => p.kind === 'text')?.text;
  if (!text) throw new Error('Delegation message has no text part.');

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Delegation payload is not valid JSON.');
  }

  const p = raw as Partial<DelegationPayload>;
  if (!p || typeof p.repoPath !== 'string' || typeof p.userPrompt !== 'string') {
    throw new Error('Delegation payload missing required fields (repoPath, userPrompt).');
  }

  return {
    repoPath: p.repoPath,
    userPrompt: p.userPrompt,
    writeScope: Array.isArray(p.writeScope) ? p.writeScope : ['.'],
    projectTree: typeof p.projectTree === 'string' ? p.projectTree : '',
    projectMemory: typeof p.projectMemory === 'string' ? p.projectMemory : null,
    figmaData: typeof p.figmaData === 'string' ? p.figmaData : null,
    learnedPatterns: typeof p.learnedPatterns === 'string' ? p.learnedPatterns : null,
    baselineFailures: typeof p.baselineFailures === 'string' ? p.baselineFailures : null,
    projectName: typeof p.projectName === 'string' ? p.projectName : 'unknown',
    correlationRunId: typeof p.correlationRunId === 'string' ? p.correlationRunId : '',
    correlationTaskId: typeof p.correlationTaskId === 'string' ? p.correlationTaskId : '',
  };
}

/** Encode the result as a JSON string for an artifact text part. */
export function encodeResult(result: DelegationResult): string {
  return JSON.stringify(result);
}

/** Parse a result JSON string (from the Dev Squad's 'result' artifact). */
export function parseResult(text: string): DelegationResult {
  const raw = JSON.parse(text) as Partial<DelegationResult>;
  return {
    targetRoute: typeof raw.targetRoute === 'string' ? raw.targetRoute : '/',
    commitMessage: typeof raw.commitMessage === 'string' ? raw.commitMessage : 'feat: auto-update',
    tokenUsage: typeof raw.tokenUsage === 'number' ? raw.tokenUsage : 0,
    iterations: typeof raw.iterations === 'number' ? raw.iterations : 0,
    filesRead: Array.isArray(raw.filesRead) ? raw.filesRead : [],
    toolHistory: Array.isArray(raw.toolHistory) ? raw.toolHistory : [],
  };
}
