/**
 * Dev Squad AgentExecutor — REAL (Phase A Step 3).
 *
 * Wraps the existing Explorer→Architect→Implementer pipeline and runs it against
 * a git worktree PATH supplied in the delegation. Reports progress + a result
 * artifact over A2A. See planning-docs/A2A_PHASE_A_DESIGN.md §7.1.
 *
 * STATELESS by contract:
 *  - Never WRITES SQLite. It does not pass `runId`/`taskId` into the LLM layer,
 *    which is what triggers telemetry/token-tracking writes (see completion.ts).
 *    The Explorer's knowledge-graph access is read-only and WAL-safe.
 *  - Never commits/pushes. It only edits files in the worktree; `core` owns the
 *    commit/scope-gate/reviewer/integrate tail.
 *  - Token usage is returned in the result so `core` can persist it.
 */
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from '@a2a-js/sdk/server';
import { runAgentPipeline } from '../../services/ai/agent-roles.js';
import { generateAndWriteCode } from '../../services/ai/agent-runner.js';
import { initialTask, statusUpdate, artifactUpdate } from '../shared/events.js';
import { parseDelegation, encodeResult, type DelegationResult } from '../shared/delegation.js';

export class DevSquadExecutor implements AgentExecutor {
  /** Abort controllers for in-flight tasks, keyed by A2A taskId (for cancelTask). */
  private readonly inFlight = new Map<string, AbortController>();

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const abort = new AbortController();
    this.inFlight.set(taskId, abort);

    if (!task) bus.publish(initialTask(taskId, contextId, userMessage));

    let delegation;
    try {
      delegation = parseDelegation(userMessage);
    } catch (err: any) {
      bus.publish(statusUpdate(taskId, contextId, 'failed', true, `Bad delegation: ${err?.message || String(err)}`));
      bus.finished();
      this.inFlight.delete(taskId);
      return;
    }

    const progress = (msg: string): void => {
      bus.publish(statusUpdate(taskId, contextId, 'working', false, msg));
    };

    try {
      bus.publish(statusUpdate(taskId, contextId, 'working', false, 'Dev Squad received delegation.'));

      // Phase 1+2: Explorer → Architect (non-blocking; falls back to direct impl).
      // NOTE: runId/taskId intentionally omitted → no telemetry/token-tracking writes.
      let architectContext: string | null = null;
      try {
        const pipeline = await runAgentPipeline({
          repoPath: delegation.repoPath,
          userPrompt: delegation.userPrompt,
          projectTree: delegation.projectTree,
          projectMemory: delegation.projectMemory,
          projectName: delegation.projectName,
          writeScope: delegation.writeScope,
          signal: abort.signal,
          onProgress: (m) => progress(m),
        });
        architectContext = pipeline.implementerContext;
        progress(
          `Pipeline: ${pipeline.explorationReport.entryPoints.length} entry points, ${pipeline.architectPlan.fileChanges.length} planned changes.`,
        );
      } catch (pipelineErr: any) {
        if (abort.signal.aborted) throw pipelineErr;
        progress('Explorer/Architect pipeline skipped; proceeding with direct implementation.');
      }

      // Phase 3: Implementer — writes edits into the worktree (no commit).
      const execution = await generateAndWriteCode({
        repoPath: delegation.repoPath,
        userPrompt: delegation.userPrompt,
        figmaData: delegation.figmaData,
        projectTree: delegation.projectTree,
        projectMemory: delegation.projectMemory,
        currentDiff: null,
        learnedPatterns: delegation.learnedPatterns,
        architectContext,
        baselineFailures: delegation.baselineFailures,
        signal: abort.signal,
        // runId/taskId omitted on purpose → stateless (no SQLite writes from this process).
        projectName: delegation.projectName,
        onStatusUpdate: (status, thought) => progress(thought ? `${status}\n> ${thought}` : status),
      });

      const result: DelegationResult = {
        targetRoute: execution.targetRoute,
        commitMessage: execution.commitMessage,
        tokenUsage: execution.tokenUsage,
        iterations: execution.iterations,
        filesRead: execution.filesRead,
        toolHistory: execution.toolHistory,
      };

      bus.publish(artifactUpdate(taskId, contextId, 'result', encodeResult(result), 'delegation-result.json'));
      bus.publish(statusUpdate(taskId, contextId, 'completed', true));
      bus.finished();
    } catch (err: any) {
      const aborted = abort.signal.aborted || err?.message === 'AbortError' || err?.name === 'AbortError';
      bus.publish(
        statusUpdate(
          taskId,
          contextId,
          aborted ? 'canceled' : 'failed',
          true,
          aborted ? 'Task canceled.' : `Implementation failed: ${err?.message || String(err)}`,
        ),
      );
      bus.finished();
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  cancelTask = async (taskId: string, _bus: ExecutionEventBus): Promise<void> => {
    this.inFlight.get(taskId)?.abort();
  };
}
