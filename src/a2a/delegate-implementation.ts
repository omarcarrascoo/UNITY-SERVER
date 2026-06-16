/**
 * The A2A delegation branch of `executeTask` (Phase A Step 5).
 *
 * When `A2A_DELEGATE=1`, the orchestrator routes the *implementation* step
 * (Explorer→Architect→Implementer) to the Dev Squad process over A2A instead of
 * running it in-process. The git/gate/reviewer/integrate tail stays in `core`,
 * unchanged — this function returns the SAME shape the in-process path produces.
 *
 * Token telemetry: the stateless Dev Squad doesn't write SQLite, so `core` emits
 * a single rollup telemetry event here using the returned tokenUsage, keeping
 * cost dashboards accurate (parity with the in-process per-call telemetry).
 */
import { sendDelegation } from './clients/dev-squad.client.js';
import { bridgeDelegationStream } from './shared/task-bridge.js';
import type { DelegationPayload } from './shared/delegation.js';
import { getTelemetryStore } from '../services/telemetry/telemetry-store.js';

/** Result shape shared with the in-process path (subset of generateAndWriteCode's return). */
export interface ImplementationResult {
  targetRoute: string;
  commitMessage: string;
  tokenUsage: number;
  iterations: number;
  toolHistory: string[];
  filesRead: string[];
}

/** Is the A2A delegation branch enabled? */
export function isA2ADelegationEnabled(): boolean {
  return process.env.A2A_DELEGATE === '1';
}

export interface DelegateParams {
  repoPath: string;
  userPrompt: string;
  writeScope: string[];
  projectTree: string;
  projectMemory: string | null;
  figmaData: string | null;
  learnedPatterns: string | null;
  baselineFailures: string | null;
  projectName: string;
  runId: string;
  taskId: string;
  onProgress?: (message: string) => Promise<void>;
}

/**
 * Delegate implementation to the Dev Squad and return the result in the same
 * shape the in-process path yields. Throws if the squad doesn't reach
 * `completed` or returns no result, so the caller's existing retry/fail logic
 * handles it identically to an in-process failure.
 */
export async function delegateImplementation(params: DelegateParams): Promise<ImplementationResult> {
  const payload: DelegationPayload = {
    repoPath: params.repoPath,
    userPrompt: params.userPrompt,
    writeScope: params.writeScope,
    projectTree: params.projectTree,
    projectMemory: params.projectMemory,
    figmaData: params.figmaData,
    learnedPatterns: params.learnedPatterns,
    baselineFailures: params.baselineFailures,
    projectName: params.projectName,
    correlationRunId: params.runId,
    correlationTaskId: params.taskId,
  };

  const stream = await sendDelegation(payload);
  const outcome = await bridgeDelegationStream(stream, {
    runId: params.runId,
    taskId: params.taskId,
    onProgress: params.onProgress ? (m) => params.onProgress!(m) : undefined,
  });

  if (outcome.terminalState !== 'completed' || !outcome.result) {
    throw new Error(
      `Dev Squad delegation did not complete (state: ${outcome.terminalState ?? 'unknown'}).`,
    );
  }

  // core emits the token rollup the stateless squad couldn't write.
  try {
    getTelemetryStore().emit({
      runId: params.runId,
      taskId: params.taskId,
      projectName: params.projectName,
      event: 'llm.code-gen',
      durationMs: null,
      tokensInput: null,
      tokensOutput: null,
      tokensTotal: outcome.result.tokenUsage,
      model: 'deepseek-v4-pro',
      status: 'success',
      metadata: { via: 'a2a-dev-squad', iterations: outcome.result.iterations },
    });
  } catch (err) {
    console.warn('Token rollup telemetry failed (non-fatal):', err);
  }

  return {
    targetRoute: outcome.result.targetRoute,
    commitMessage: outcome.result.commitMessage,
    tokenUsage: outcome.result.tokenUsage,
    iterations: outcome.result.iterations,
    toolHistory: outcome.result.toolHistory,
    filesRead: outcome.result.filesRead,
  };
}
