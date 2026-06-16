import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { getRuntimeConfig, getProjectByName } from '../config.js';

const execPromise = util.promisify(exec);
import { getFigmaContext } from '../figma.js';
import { prepareWorkspace, refreshWorkspaceDependencies } from '../git.js';
import { getProjectMemory, getProjectTree } from '../scanner.js';
import { generateAndWriteCode } from '../ai.js';
import type {
  GateResult,
  PlanTaskDraft,
  ReviewResult,
  RunPlanDraft,
  RunMode,
  RunRecord,
  TaskExecutionOutcome,
  TaskRecord,
} from '../domain/orchestration.js';
import type { AutonomousRunPolicy } from '../domain/policies.js';
import type { PreparedWorkspace, WorkspaceProject } from '../domain/runtime.js';
import { unityStore } from '../runtime/services.js';
import { createEntityId } from '../shared/ids.js';
import {
  checkoutBranch,
  cherryPickCommit,
  commitAllChanges,
  ensureIntegrationBranch,
  getDiffAgainstHead,
  pushBranch,
} from '../services/orchestration/branch-manager.js';
import { runRuntimeGate, runRuntimeGateDetailed, runStaticGates, summarizeGateResults } from '../services/orchestration/gates.js';
import { buildRuntimeRepairTasks, hasHealableFailures } from '../services/orchestration/runtime-healing.js';
import { planAutonomousRun } from '../services/orchestration/planner.js';
import { getProjectPolicy } from '../services/orchestration/policy-engine.js';
import { reviewTaskResult } from '../services/orchestration/reviewer.js';
import { createTaskWorktree, removeTaskWorktree } from '../services/orchestration/worktree-manager.js';
import { buildLearningContext, extractPattern, recordPatternOutcomes } from '../services/learning/index.js';
import { runAgentPipeline } from '../services/ai/agent-roles.js';
import { getKnowledgeGraph } from '../services/knowledge/index.js';
import {
  isA2ADelegationEnabled,
  delegateImplementation,
  type ImplementationResult,
} from '../a2a/delegate-implementation.js';

interface RunAutonomousAgentParams {
  project: WorkspaceProject;
  prompt: string;
  channelName: string;
  mode?: RunMode;
  signal?: AbortSignal;
  onProgress?: (message: string) => Promise<void>;
}

interface CreateAutonomousRunPlanResult {
  runId: string;
  branchName: string;
  defaultBranch: string;
  planSummary: string;
  consoleUrl: string;
  requiresApproval: boolean;
  autoApproved: boolean;
  tasks: Array<{
    title: string;
    writeScope: string[];
    dependencies: string[];
  }>;
}

interface ResumeAutonomousRunParams {
  runId: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => Promise<void>;
}

interface RunAutonomousAgentResult {
  runId: string;
  branchName: string;
  defaultBranch: string;
  summary: string;
  commitsCreated: number;
  runtimeUrls: {
    localUrl: string | null;
    publicUrl: string | null;
  };
  tasks: Array<{
    title: string;
    status: TaskRecord['status'];
    commitMessage?: string | null;
  }>;
}

interface ExecutedTaskResult {
  task: TaskRecord;
  outcome: TaskExecutionOutcome;
  review: ReviewResult;
  diff: string;
  targetRoute: string;
}

const ADVISORY_TITLE_PATTERN =
  /^(analy[sz]e|analy[sz]ing|analysis|analizar|revisar|review|inspect|investigate|diagnose|audit|explore)\b/i;
const RUN_CLOSING_WINDOW_MS = 10 * 60 * 1000;

interface RunBudgetState {
  remainingMs: number;
  inClosingWindow: boolean;
  exhausted: boolean;
}

interface RunClosureAssessment {
  status: RunRecord['status'];
  outcomeLabel: string;
  summaryReason: string;
  warnings: string[];
  failures: string[];
  requiredTasksCompleted: number;
  requiredTasksTotal: number;
  incompleteFollowUpTasks: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatRemainingTime(remainingMs: number): string {
  const safeMs = Math.max(0, remainingMs);
  const totalMinutes = Math.ceil(safeMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes} minute(s)`;
  }

  return `${hours} hour(s) ${minutes} minute(s)`;
}

function truncateForSummary(value: string, maxLength = 220): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function getRunBudgetState(deadline: number): RunBudgetState {
  const remainingMs = deadline - Date.now();

  return {
    remainingMs,
    inClosingWindow: remainingMs <= RUN_CLOSING_WINDOW_MS,
    exhausted: remainingMs <= 0,
  };
}

function hasScopeConflict(left: string[], right: string[]): boolean {
  const normalizedLeft = left.length ? left : ['.'];
  const normalizedRight = right.length ? right : ['.'];

  for (const leftScope of normalizedLeft) {
    for (const rightScope of normalizedRight) {
      if (leftScope === '.' || rightScope === '.') {
        return true;
      }

      if (
        leftScope === rightScope ||
        leftScope.startsWith(`${rightScope}/`) ||
        rightScope.startsWith(`${leftScope}/`)
      ) {
        return true;
      }
    }
  }

  return false;
}

function normalizeScopes(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return ['.'];
  }

  const normalized = scopes
    .map((scope) => scope.trim().replace(/^\.?\//, '').replace(/\/+$/, ''))
    .filter(Boolean);

  return normalized.length ? normalized : ['.'];
}

function isPathWithinScope(filePath: string, scope: string): boolean {
  if (scope === '.') {
    return true;
  }

  return filePath === scope || filePath.startsWith(`${scope}/`);
}

function isAdvisoryTaskTitle(title: string): boolean {
  return ADVISORY_TITLE_PATTERN.test(title.trim());
}

function getRelativePackageDirs(workspace: PreparedWorkspace): string[] {
  return Array.from(
    new Set(
      workspace.packageDirs
        .map((packageDir) => path.relative(workspace.repoPath, packageDir) || '.')
        .filter((packageDir) => packageDir !== '.'),
    ),
  );
}

function getAllowedPackageDirs(workspace: PreparedWorkspace, scopes: string[]): string[] {
  if (scopes.includes('.')) {
    return getRelativePackageDirs(workspace);
  }

  const packageDirs = getRelativePackageDirs(workspace);
  return packageDirs.filter((packageDir) =>
    scopes.some((scope) => isPathWithinScope(scope, packageDir) || isPathWithinScope(packageDir, scope)),
  );
}

function extractChangedPaths(diff: string): string[] {
  const paths = new Set<string>();

  for (const line of diff.split('\n')) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) continue;
    paths.add(match[2]);
  }

  return Array.from(paths);
}

function stripKnownPackagePrefix(filePath: string, packageDirs: string[]): string {
  for (const packageDir of packageDirs) {
    if (!packageDir || packageDir === '.') continue;
    if (filePath === packageDir) return '';
    if (filePath.startsWith(`${packageDir}/`)) {
      return filePath.slice(packageDir.length + 1);
    }
  }
  return filePath;
}

function getOutOfScopePaths(workspace: PreparedWorkspace, diff: string, scopes: string[]): string[] {
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.includes('.')) {
    return [];
  }

  const allowedPackageDirs = getAllowedPackageDirs(workspace, normalizedScopes);
  const allPackageDirs = getRelativePackageDirs(workspace);
  return extractChangedPaths(diff).filter((filePath) => {
    // Exact match against a declared scope (repo-root-relative path)
    if (normalizedScopes.some((scope) => isPathWithinScope(filePath, scope))) {
      return false;
    }

    // Path falls inside an allowed package directory
    if (allowedPackageDirs.some((packageDir) => isPathWithinScope(filePath, packageDir))) {
      return false;
    }

    // Planner sometimes writes scopes as package-relative (e.g. app/profile.tsx)
    // while the diff carries repo-root paths (e.g. kubo-mobile/app/profile.tsx).
    // Strip a known package prefix and re-check.
    const stripped = stripKnownPackagePrefix(filePath, allPackageDirs);
    if (stripped && stripped !== filePath) {
      if (normalizedScopes.some((scope) => isPathWithinScope(stripped, scope))) {
        return false;
      }
    }

    return true;
  });
}

const DEPENDENCY_FILE_PATTERN = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

/** Did this task add/change a dependency manifest (so the base needs reinstall)? */
function taskChangedDependencies(writeScope: string[], diff: string): boolean {
  if (writeScope.some((scope) => DEPENDENCY_FILE_PATTERN.test(scope))) return true;
  return extractChangedPaths(diff).some((file) => DEPENDENCY_FILE_PATTERN.test(file));
}

function extractEditedFiles(diff: string): string[] {
  return Array.from(
    new Set(
      diff
        .split('\n')
        .filter((line) => line.startsWith('+++ b/'))
        .map((line) => line.replace('+++ b/', '').trim())
        .filter((filePath) => filePath && filePath !== '/dev/null'),
    ),
  );
}

function buildScopedTaskPrompt(
  task: TaskRecord,
  runPrompt: string,
  dependencyContext: string,
  options?: { inClosingWindow?: boolean; remainingMs?: number },
): string {
  const scopes = normalizeScopes(task.writeScope);
  const budgetInstructions = options?.inClosingWindow
    ? `

Time budget warning:
- The run is inside its final closing window with about ${formatRemainingTime(options.remainingMs || 0)} remaining.
- Prioritize finishing the smallest viable change for this task.
- Do not expand scope, start adjacent refactors, or generate optional follow-up work unless absolutely necessary for correctness.
- Prefer wrapping up cleanly over chasing ideal completion.`
    : '';

  return `Run goal:
${runPrompt}

Task title:
${task.title}

Writable scope:
${scopes.join(', ')}

Rules:
- Deliver concrete code changes, not analysis-only output.
- Focus on this task's scope and ignore unrelated failures elsewhere in the repo.
- Only touch files outside the task scope when they are directly required to complete the scoped change.
- Prefer the smallest correct implementation that clears scoped validation.
${budgetInstructions}

Dependency context:
${dependencyContext || '(none)'}

Task instruction:
${task.prompt}`;
}

function buildDependencyContext(task: TaskRecord, tasks: TaskRecord[]): string {
  const deps = task.dependencies
    .map((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId))
    .filter((dependency): dependency is TaskRecord => Boolean(dependency));

  if (deps.length === 0) return '';

  return deps
    .map((dependency) => {
      const summary =
        dependency.outputSummary ||
        dependency.validationSummary ||
        dependency.commitMessage ||
        `Dependency finished with status ${dependency.status}.`;

      const scopeHint = dependency.writeScope.length
        ? `  Files in scope: ${dependency.writeScope.join(', ')}`
        : '';
      const commitHint = dependency.commitMessage
        ? `  Commit: ${dependency.commitMessage}`
        : '';

      // Retrieve the diff artifact for this dependency to show which files were actually modified
      let filesModified = '';
      try {
        const artifacts = unityStore.listArtifactsByRun(dependency.runId);
        const diffArtifact = artifacts.find((a) => a.taskId === dependency.id && a.type === 'diff');
        if (diffArtifact?.content) {
          const changedFiles = extractChangedPaths(diffArtifact.content);
          if (changedFiles.length > 0) {
            filesModified = `\n  Files modified: ${changedFiles.join(', ')}`;
          }
        }
      } catch {
        // Artifact lookup failed — non-critical
      }

      return `- ${dependency.title}: ${summary}${scopeHint}${commitHint}${filesModified}`;
    })
    .join('\n');
}

function buildDependencyBlockReason(task: TaskRecord, tasks: TaskRecord[]): string {
  const blockingDependencies = task.dependencies
    .map((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId))
    .filter((dependency): dependency is TaskRecord => Boolean(dependency))
    .filter((dependency) => dependency.status === 'failed' || dependency.status === 'blocked');

  if (blockingDependencies.length === 0) {
    return 'Task remained pending because its dependencies never reached a runnable state.';
  }

  return `Blocked by dependencies: ${blockingDependencies
    .map((dependency) => `${dependency.title} [${dependency.status}]`)
    .join(', ')}.`;
}

function getNewFailedGates(baseline: GateResult[], current: GateResult[]): GateResult[] {
  const baselineStatusByName = new Map(baseline.map((gate) => [gate.name, gate.status]));

  return current.filter((gate) => {
    if (gate.status !== 'failed') {
      return false;
    }

    return baselineStatusByName.get(gate.name) !== 'failed';
  });
}

function buildRunRecord(
  runId: string,
  projectName: string,
  channelName: string,
  prompt: string,
  policy: AutonomousRunPolicy,
  branchName: string,
  defaultBranch: string,
  mode: RunMode,
): RunRecord {
  const timestamp = nowIso();

  return {
    id: runId,
    projectName,
    channelName,
    prompt,
    status: 'planning',
    mode,
    branchName,
    defaultBranch,
    maxParallelTasks: policy.maxParallelTasks,
    maxRetriesPerTask: policy.maxRetriesPerTask,
    maxImprovementCycles: policy.maxImprovementCycles,
    maxHours: policy.maxHours,
    maxCommits: policy.maxCommits,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
    summary: null,
  };
}

function buildConsoleRunUrl(runId: string): string {
  const config = getRuntimeConfig();
  return `http://localhost:${config.localConsolePort}/runs/${runId}`;
}

function createTasksFromPlan(runId: string, plan: RunPlanDraft): TaskRecord[] {
  const titleToId = new Map<string, string>();

  for (const task of plan.tasks) {
    titleToId.set(task.title, createEntityId('task'));
  }

  return plan.tasks.map((task, index) => {
    const id = titleToId.get(task.title) as string;
    const timestamp = nowIso();

    return {
      id,
      runId,
      title: task.title,
      prompt: task.prompt,
      role: 'executor',
      kind: task.kind,
      status: 'pending',
      writeScope: task.writeScope,
      dependencies: (task.dependencies || [])
        .filter((title) => !isAdvisoryTaskTitle(title))
        .map((title) => titleToId.get(title))
        .filter(Boolean) as string[],
      attempts: 0,
      branchName: null,
      worktreePath: null,
      commitSha: null,
      commitMessage: null,
      outputSummary: task.rationale || null,
      validationSummary: null,
      orderIndex: index,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      parentTaskId: null,
    };
  });
}

function buildRetryPrompt(task: TaskRecord, validationSummary: string): string {
  return `${task.prompt}

Retry context:
${validationSummary}

Repair only what is necessary to make this task pass all gates.`;
}

function dedupeFollowUpTasks(drafts: PlanTaskDraft[]): PlanTaskDraft[] {
  const seen = new Set<string>();
  const result: PlanTaskDraft[] = [];

  for (const draft of drafts) {
    const key = `${draft.title}::${draft.writeScope.join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(draft);
  }

  return result;
}

async function executeTask(
  task: TaskRecord,
  baseWorkspace: PreparedWorkspace,
  run: RunRecord,
  figmaData: string | null,
  projectMemory: string | null,
  policy: AutonomousRunPolicy,
  signal: AbortSignal | undefined,
  dependencyContext: string,
  options?: { inClosingWindow?: boolean; remainingMs?: number },
  onProgress?: (message: string) => Promise<void>,
): Promise<ExecutedTaskResult> {
  const taskWorktree = await createTaskWorktree(baseWorkspace, run.id, task.id, run.branchName, task.writeScope);
  unityStore.updateTask(task.id, {
    status: 'running',
    attempts: task.attempts + 1,
    branchName: taskWorktree.branchName,
    worktreePath: taskWorktree.worktreePath,
    startedAt: nowIso(),
  });

  // Per-task timeout: combine run-level signal with task-level deadline
  // TODO: Re-enable per-task timeout after testing — currently disabled to avoid premature aborts
  const taskAbortController = new AbortController();
  let taskTimer: ReturnType<typeof setTimeout> | undefined;
  // const taskTimeoutMs = policy.maxMinutesPerTask > 0
  //   ? policy.maxMinutesPerTask * 60 * 1000
  //   : 0;
  // if (taskTimeoutMs > 0) {
  //   taskTimer = setTimeout(() => {
  //     console.warn(`⏱️ Task "${task.title}" exceeded ${policy.maxMinutesPerTask} minute budget — aborting.`);
  //     taskAbortController.abort(new Error(`Task timeout: exceeded ${policy.maxMinutesPerTask} minute budget`));
  //   }, taskTimeoutMs);
  // }
  // Forward run-level abort to task-level controller
  if (signal) {
    if (signal.aborted) {
      taskAbortController.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => taskAbortController.abort(signal.reason), { once: true });
    }
  }
  const taskSignal = taskAbortController.signal;

  try {
    if (onProgress) {
      await onProgress(`🧪 [${task.title}] Running baseline scoped gates before editing...`);
    }
    const baselineStaticGates = await runStaticGates(taskWorktree.workspace, policy, task.writeScope);
    const projectTree = getProjectTree(taskWorktree.workspace.repoPath);

    // Build learning context from past successful patterns
    const learningContext = buildLearningContext({
      projectName: run.projectName,
      taskKind: task.kind,
      taskTitle: task.title,
      taskPrompt: task.prompt,
      writeScope: task.writeScope,
    });

    if (learningContext.appliedPatternIds.length > 0 && onProgress) {
      await onProgress(`📚 [${task.title}] Injecting ${learningContext.appliedPatternIds.length} learned pattern(s).`);
    }

    // Build baseline failure context so the agent doesn't waste iterations on pre-existing errors
    const failedBaselineGates = baselineStaticGates.filter((g) => g.status === 'failed');
    const baselineFailures = failedBaselineGates.length > 0
      ? failedBaselineGates.map((g) => `- ${g.name}: ${g.details.substring(0, 300)}`).join('\n')
      : null;

    const scopedPrompt = buildScopedTaskPrompt(task, run.prompt, dependencyContext, options);

    let execution: ImplementationResult;

    if (isA2ADelegationEnabled()) {
      // ── A2A path: delegate implementation to the Dev Squad process ──
      // The Explorer→Architect→Implementer pipeline runs there; core keeps the
      // commit/scope-gate/reviewer/integrate tail below. Same result shape.
      if (onProgress) {
        await onProgress(`🛰️ [${task.title}] Delegating implementation to Dev Squad over A2A...`);
      }
      execution = await delegateImplementation({
        repoPath: taskWorktree.workspace.repoPath,
        userPrompt: scopedPrompt,
        writeScope: task.writeScope,
        projectTree,
        projectMemory,
        figmaData,
        learnedPatterns: learningContext.promptSection || null,
        baselineFailures,
        projectName: run.projectName,
        runId: run.id,
        taskId: task.id,
        onProgress: onProgress ? (msg) => onProgress(`🛰️ [${task.title}] ${msg}`) : undefined,
      });
    } else {
      // ── In-process path (unchanged) ──
      // Run Explorer → Architect pipeline for richer context
      let architectContext: string | null = null;
      try {
        if (onProgress) {
          await onProgress(`🔍 [${task.title}] Running Explorer → Architect pipeline...`);
        }
        const pipeline = await runAgentPipeline({
          repoPath: taskWorktree.workspace.repoPath,
          userPrompt: scopedPrompt,
          projectTree,
          projectMemory,
          projectName: run.projectName,
          writeScope: task.writeScope,
          signal: taskSignal,
          onProgress: onProgress ? (msg) => onProgress(`🤖 [${task.title}] ${msg}`) : undefined,
          runId: run.id,
          taskId: task.id,
        });
        architectContext = pipeline.implementerContext;
        if (onProgress) {
          await onProgress(
            `📐 [${task.title}] Pipeline complete: ${pipeline.explorationReport.entryPoints.length} entry points, ${pipeline.architectPlan.fileChanges.length} planned changes`,
          );
        }
      } catch (pipelineError: any) {
        // Pipeline is non-blocking — fall back to direct implementation
        console.warn(`[unity] Explorer/Architect pipeline failed for task ${task.id}:`, pipelineError.message);
        if (onProgress) {
          await onProgress(`⚠️ [${task.title}] Explorer/Architect pipeline skipped, proceeding with direct implementation.`);
        }
      }

      execution = await generateAndWriteCode({
        repoPath: taskWorktree.workspace.repoPath,
        userPrompt: scopedPrompt,
        figmaData,
        projectTree,
        projectMemory,
        currentDiff: null,
        learnedPatterns: learningContext.promptSection || null,
        architectContext,
        baselineFailures,
        signal: taskSignal,
        runId: run.id,
        taskId: task.id,
        projectName: run.projectName,
        onStatusUpdate: (status, thought) => {
          if (!onProgress) return;
          return onProgress(`🧩 [${task.title}] ${status}${thought ? `\n> ${thought}` : ''}`);
        },
        onThinking: (iteration, reasoning) => {
          const trimmed = reasoning.length > 2048 ? reasoning.slice(0, 2048) + '…' : reasoning;
          unityStore.addEvent(
            createEntityId('event'),
            run.id,
            task.id,
            'info',
            'agent.thinking',
            `Iteration ${iteration}: ${trimmed}`,
          );
        },
      });
    }

    if (onProgress) {
      await onProgress(`🧩 [${task.title}] Patch accepted by scoped compiler checks. Preparing commit...`);
    }
    const commitSha = await commitAllChanges(
      taskWorktree.workspace.repoPath,
      execution.commitMessage || `chore: ${task.title.toLowerCase()}`,
    );

    if (onProgress) {
      await onProgress(
        commitSha
          ? `💾 [${task.title}] Created task commit ${commitSha.slice(0, 8)}. Running scope/reviewer gates...`
          : `⏭️ [${task.title}] No file changes were produced, so no task commit was created.`,
      );
    }

    const diff = commitSha ? await getDiffAgainstHead(taskWorktree.workspace.repoPath) : '';
    const outOfScopePaths = getOutOfScopePaths(taskWorktree.workspace, diff, task.writeScope);
    const scopeGateResults: GateResult[] = outOfScopePaths.length
      ? [
          {
            name: 'scope',
            status: 'failed',
            details: `Task touched files outside its allowed scope: ${outOfScopePaths.join(', ')}`,
          },
        ]
      : [
          {
            name: 'scope',
            status: 'passed',
            details: `Task stayed inside scope: ${normalizeScopes(task.writeScope).join(', ')}`,
          },
        ];
    const currentScopedGates = await runStaticGates(taskWorktree.workspace, policy, task.writeScope);
    const newScopedFailures = getNewFailedGates(baselineStaticGates, currentScopedGates);
    const baselineDeltaGate: GateResult = {
      name: 'baseline-delta',
      status: newScopedFailures.length > 0 ? 'failed' : 'passed',
      details: newScopedFailures.length
        ? `Task introduced new scoped gate failures: ${newScopedFailures.map((gate) => gate.name).join(', ')}`
        : 'No new scoped gate failures compared with the baseline.',
    };
    const staticGates = [
      ...scopeGateResults,
      baselineDeltaGate,
      ...currentScopedGates,
    ];
    const review = await reviewTaskResult({
      runPrompt: run.prompt,
      taskTitle: task.title,
      taskPrompt: task.prompt,
      diff,
      gateResults: staticGates,
      runId: run.id,
      taskId: task.id,
      projectName: run.projectName,
    });

    if (onProgress) {
      await onProgress(
        `🔎 [${task.title}] Reviewer ${review.approved ? 'approved' : 'rejected'} the task. Scope gate: ${
          scopeGateResults[0]?.status || 'unknown'
        }. Baseline delta: ${baselineDeltaGate.status}.`,
      );
    }

    const validationSummary = `${summarizeGateResults(staticGates)}\n\nReviewer: ${review.summary}`;
    const hasFailedGate = scopeGateResults.some((gate) => gate.status === 'failed') || baselineDeltaGate.status === 'failed';
    const status: TaskExecutionOutcome['status'] =
      !commitSha ? 'skipped' : hasFailedGate || !review.approved ? 'failed' : 'succeeded';

    // Learning loop: record outcomes for applied patterns
    if (learningContext.appliedPatternIds.length > 0) {
      recordPatternOutcomes({
        appliedPatternIds: learningContext.appliedPatternIds,
        taskId: task.id,
        runId: run.id,
        succeeded: status === 'succeeded',
        iterations: execution.iterations || 0,
        tokensUsed: execution.tokenUsage,
      });
    }

    // Learning loop: extract new pattern from successful tasks
    if (status === 'succeeded' && commitSha) {
      extractPattern({
        runId: run.id,
        taskId: task.id,
        projectName: run.projectName,
        taskTitle: task.title,
        taskKind: task.kind,
        taskPrompt: task.prompt,
        writeScope: task.writeScope,
        iterations: execution.iterations || 0,
        tokensUsed: execution.tokenUsage,
        filesRead: execution.filesRead || [],
        filesEdited: extractEditedFiles(diff),
        toolHistory: execution.toolHistory || [],
        commitMessage: execution.commitMessage,
        gateResults: staticGates.map((g) => ({ name: g.name, status: g.status })),
      }).catch((err) => {
        console.warn(`📚 Pattern extraction failed for task ${task.id}:`, err?.message);
      });
    }

    return {
      task,
      diff,
      review,
      targetRoute: execution.targetRoute,
      outcome: {
        taskId: task.id,
        status,
        commitSha: commitSha || undefined,
        commitMessage: execution.commitMessage,
        outputSummary: review.summary,
        validationSummary,
        gates: staticGates,
        targetRoute: execution.targetRoute,
        tokenUsage: execution.tokenUsage,
      },
    };
  } finally {
    if (taskTimer) clearTimeout(taskTimer);
    await removeTaskWorktree(baseWorkspace.repoPath, taskWorktree.worktreePath);
  }
}

async function integrateTaskResult(
  baseWorkspace: PreparedWorkspace,
  run: RunRecord,
  executedTask: ExecutedTaskResult,
): Promise<void> {
  if (!executedTask.outcome.commitSha) {
    return;
  }

  await checkoutBranch(baseWorkspace.repoPath, run.branchName);

  const result = await cherryPickCommit(baseWorkspace.repoPath, executedTask.outcome.commitSha);

  if (!result.success) {
    const detail = result.conflicting
      ? `Cherry-pick conflict in ${result.conflictFiles.length} file(s): ${result.conflictFiles.join(', ')}`
      : result.error || 'Cherry-pick failed for unknown reason';
    throw new Error(detail);
  }

  if (result.conflicting && result.conflictFiles.length > 0) {
    console.log(`🔧 Auto-resolved conflicts during integration of task commit: ${result.conflictFiles.join(', ')}`);
  }

  try {
    await pushBranch(baseWorkspace.repoPath, run.branchName);
  } catch (pushError) {
    // Push failed (e.g. SSL timeout) — revert the cherry-pick to restore clean integration branch
    // so the next retry attempt starts from a consistent state
    console.warn(`⚠️ Push failed after cherry-pick, reverting to restore clean state: ${pushError instanceof Error ? pushError.message : String(pushError)}`);
    try {
      await execPromise('git reset --hard HEAD~1', { cwd: baseWorkspace.repoPath });
    } catch (revertError) {
      console.error('Failed to revert cherry-pick after push failure:', revertError);
    }
    throw pushError;
  }
}

function createImprovementTasks(
  runId: string,
  cycle: number,
  drafts: PlanTaskDraft[],
  startIndex: number,
): TaskRecord[] {
  return drafts.map((draft, index) => {
    const timestamp = nowIso();

    return {
      id: createEntityId('task'),
      runId,
      parentTaskId: null,
      title: `[Improvement ${cycle}] ${draft.title}`,
      prompt: draft.prompt,
      role: 'executor',
      kind: draft.kind || 'improve',
      status: 'pending',
      writeScope: draft.writeScope,
      dependencies: [],
      attempts: 0,
      branchName: null,
      worktreePath: null,
      commitSha: null,
      commitMessage: null,
      outputSummary: draft.rationale || null,
      validationSummary: null,
      orderIndex: startIndex + index,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
    };
  });
}

function selectRunnableBatch(tasks: TaskRecord[], maxParallelTasks: number): TaskRecord[] {
  const orderedTasks = [...tasks].sort((left, right) => {
    const advisoryDelta = Number(isAdvisoryTaskTitle(left.title)) - Number(isAdvisoryTaskTitle(right.title));
    if (advisoryDelta !== 0) {
      return advisoryDelta;
    }

    return left.orderIndex - right.orderIndex;
  });
  const running: TaskRecord[] = [];

  for (const task of orderedTasks) {
    const conflicts = running.some((candidate) => hasScopeConflict(candidate.writeScope, task.writeScope));
    if (conflicts) continue;

    running.push(task);
    if (running.length >= maxParallelTasks) break;
  }

  return running;
}

function formatRunSummary(
  run: RunRecord,
  assessment: RunClosureAssessment,
  tasks: TaskRecord[],
  commitsCreated: number,
  budgetNote: string | null,
  baselineStaticResults: GateResult[],
  staticResults: GateResult[],
  runtimeResults: GateResult[],
): string {
  const successfulTasks = tasks.filter((task) => task.status === 'succeeded' || task.status === 'skipped').length;
  const gateOverview = (label: string, results: GateResult[]): string => {
    if (results.length === 0) {
      return `${label}: not executed.`;
    }

    const failed = results.filter((gate) => gate.status === 'failed');
    const passed = results.filter((gate) => gate.status === 'passed');
    const skipped = results.filter((gate) => gate.status === 'skipped');
    const counts = [`passed ${passed.length}`];

    if (failed.length > 0) {
      counts.push(`failed ${failed.length}`);
    }

    if (skipped.length > 0) {
      counts.push(`skipped ${skipped.length}`);
    }

    const failedNames = failed.map((gate) => gate.name);
    return `${label}: ${counts.join(', ')}${
      failedNames.length ? `. Failed gates: ${failedNames.join(', ')}.` : '.'
    }`;
  };

  return [
    `Run ${run.id} finished on branch ${run.branchName}.`,
    `Outcome: ${assessment.outcomeLabel}.`,
    `Why: ${assessment.summaryReason}`,
    `Required plan tasks completed: ${assessment.requiredTasksCompleted}/${assessment.requiredTasksTotal}.`,
    `Total successful tasks: ${successfulTasks}/${tasks.length}.`,
    `Commits created: ${commitsCreated}/${run.maxCommits}.`,
    budgetNote ? `Budget note: ${budgetNote}` : 'Budget note: within configured limits.',
    assessment.warnings.length ? `Warnings:\n- ${assessment.warnings.join('\n- ')}` : 'Warnings: none.',
    assessment.failures.length ? `Blocking issues:\n- ${assessment.failures.join('\n- ')}` : 'Blocking issues: none.',
    gateOverview('Baseline static gates', baselineStaticResults),
    gateOverview('Final static gates', staticResults),
    gateOverview('Runtime gates', runtimeResults),
    'Full gate logs are stored in run artifacts.',
  ].join('\n');
}

function assessRunClosure(
  planTaskCount: number,
  tasks: TaskRecord[],
  baselineStaticResults: GateResult[],
  finalStaticResults: GateResult[],
  runtimeResults: GateResult[],
  budgetNote: string | null,
): RunClosureAssessment {
  const requiredTasks = tasks.filter((task) => task.orderIndex < planTaskCount);
  const followUpTasks = tasks.filter((task) => task.orderIndex >= planTaskCount);
  const resolvedStatuses = new Set<TaskRecord['status']>(['succeeded', 'skipped']);
  const requiredIncomplete = requiredTasks.filter((task) => !resolvedStatuses.has(task.status));
  const incompleteFollowUps = followUpTasks.filter((task) => !resolvedStatuses.has(task.status));
  const newStaticFailures = getNewFailedGates(baselineStaticResults, finalStaticResults);
  const runtimeFailures = runtimeResults.filter((gate) => gate.status === 'failed');
  const warnings: string[] = [];
  const failures: string[] = [];

  if (requiredTasks.length === 0) {
    failures.push('The run did not produce any required executable tasks.');
  }

  if (requiredIncomplete.length > 0) {
    failures.push(
      `Required tasks did not finish cleanly: ${requiredIncomplete
        .slice(0, 4)
        .map((task) => `${task.title} [${task.status}]`)
        .join(', ')}${requiredIncomplete.length > 4 ? '…' : ''}.`,
    );
  }

  if (newStaticFailures.length > 0) {
    failures.push(
      `The run introduced new static gate failures: ${newStaticFailures.map((gate) => gate.name).join(', ')}.`,
    );
  }

  if (runtimeFailures.length > 0) {
    warnings.push(
      `Runtime verification did not complete: ${runtimeFailures
        .map((gate) => truncateForSummary(gate.details, 180))
        .join(' | ')}`,
    );
  }

  if (budgetNote) {
    warnings.push(budgetNote);
  }

  if (incompleteFollowUps.length > 0) {
    warnings.push(
      `Some follow-up tasks were left incomplete: ${incompleteFollowUps
        .slice(0, 4)
        .map((task) => `${task.title} [${task.status}]`)
        .join(', ')}${incompleteFollowUps.length > 4 ? '…' : ''}.`,
    );
  }

  if (failures.length > 0) {
    return {
      status: 'failed',
      outcomeLabel: 'failed',
      summaryReason: failures[0],
      warnings,
      failures,
      requiredTasksCompleted: requiredTasks.length - requiredIncomplete.length,
      requiredTasksTotal: requiredTasks.length,
      incompleteFollowUpTasks: incompleteFollowUps.length,
    };
  }

  if (warnings.length > 0) {
    return {
      status: 'completed_with_warnings',
      outcomeLabel: 'completed with warnings',
      summaryReason:
        'Primary plan tasks were completed, but the run needs manual follow-up for remaining warnings.',
      warnings,
      failures,
      requiredTasksCompleted: requiredTasks.length,
      requiredTasksTotal: requiredTasks.length,
      incompleteFollowUpTasks: incompleteFollowUps.length,
    };
  }

  return {
    status: 'completed',
    outcomeLabel: 'completed',
    summaryReason: 'All required plan tasks completed cleanly and no new blocking gates were introduced.',
    warnings,
    failures,
    requiredTasksCompleted: requiredTasks.length,
    requiredTasksTotal: requiredTasks.length,
    incompleteFollowUpTasks: incompleteFollowUps.length,
  };
}

function shouldAutoApprovePlan(mode: RunMode, policy: AutonomousRunPolicy): boolean {
  return mode === 'nightly' && policy.autoApprovePlan;
}

function loadBaselineStaticResults(runId: string): GateResult[] {
  const baselineArtifact = unityStore
    .listArtifactsByRun(runId)
    .find((artifact) => artifact.type === 'baseline-static-gates');

  if (!baselineArtifact?.content) {
    return [];
  }

  try {
    return JSON.parse(baselineArtifact.content) as GateResult[];
  } catch {
    return [];
  }
}

async function executeApprovedRun(
  run: RunRecord,
  project: WorkspaceProject,
  plan: RunPlanDraft,
  policy: AutonomousRunPolicy,
  baseWorkspace: PreparedWorkspace,
  baselineStaticResults: GateResult[],
  signal?: AbortSignal,
  onProgress?: (message: string) => Promise<void>,
): Promise<RunAutonomousAgentResult> {
  const figmaData = await getFigmaContext(run.prompt);
  const projectMemory = getProjectMemory(baseWorkspace.repoPath);
  const existingTasks = unityStore.listTasksByRun(run.id);

  if (existingTasks.length === 0) {
    const initialTasks = createTasksFromPlan(run.id, plan);
    for (const task of initialTasks) {
      unityStore.createTask(task);
    }
  }

  const deadline = Date.now() + policy.maxHours * 60 * 60 * 1000;
  let closingWindowAnnounced = false;
  let gracefulDrainRequested = false;
  let commitsCreated = 0;
  let improvementCycle = 0;
  let pendingImprovementDrafts: PlanTaskDraft[] = [];
  let latestTargetRoute = '/';
  let budgetNote: string | null = null;
  // Runtime auto-healing state: cache the last in-loop runtime gate result so the
  // closure can reuse it instead of running the gate a second time.
  let runtimeResultsFromHealing: GateResult[] | null = null;
  let runtimeHealCycles = 0;
  let depsTouchedDuringRun = false;

  while (commitsCreated < policy.maxCommits) {
    if (signal?.aborted) {
      throw new Error('AbortError');
    }

    const budgetState = getRunBudgetState(deadline);

    if (budgetState.inClosingWindow && !closingWindowAnnounced) {
      closingWindowAnnounced = true;
      gracefulDrainRequested = true;

      unityStore.addEvent(
        createEntityId('event'),
        run.id,
        null,
        'warning',
        'run.closing_window',
        `Run entered closing window with about ${formatRemainingTime(budgetState.remainingMs)} remaining.`,
      );

      if (onProgress) {
        await onProgress(
          `⏳ Unity Agent entered its final closing window with about ${formatRemainingTime(
            budgetState.remainingMs,
          )} remaining. It will stop opening new improvement cycles and focus on wrapping up cleanly.`,
        );
      }
    }

    if (budgetState.exhausted) {
      break;
    }

    const allTasks = unityStore.listTasksByRun(run.id);
    const succeededTaskIds = new Set(
      allTasks.filter((task) => task.status === 'succeeded' || task.status === 'skipped').map((task) => task.id),
    );

    const readyTasks = allTasks.filter(
      (task) =>
        task.status === 'pending' && task.dependencies.every((dependencyId) => succeededTaskIds.has(dependencyId)),
    );

    if (readyTasks.length === 0) {
      const unresolvedTasks = allTasks.some((task) => task.status === 'pending' || task.status === 'running');
      if (unresolvedTasks) {
        for (const task of allTasks.filter((candidate) => candidate.status === 'pending')) {
          unityStore.updateTask(task.id, {
            status: 'blocked',
            validationSummary: buildDependencyBlockReason(task, allTasks),
            finishedAt: nowIso(),
          });
        }
        break;
      }

      if (
        pendingImprovementDrafts.length > 0 &&
        !gracefulDrainRequested &&
        improvementCycle < policy.maxImprovementCycles &&
        commitsCreated < policy.maxCommits
      ) {
        improvementCycle += 1;
        unityStore.updateRun(run.id, { status: 'healing' });
        const tasksToCreate = createImprovementTasks(
          run.id,
          improvementCycle,
          dedupeFollowUpTasks(pendingImprovementDrafts),
          allTasks.length,
        );
        pendingImprovementDrafts = [];

        for (const task of tasksToCreate) {
          unityStore.createTask(task);
        }

        if (onProgress) {
          await onProgress(`♻️ Starting self-improvement cycle ${improvementCycle} with ${tasksToCreate.length} tasks.`);
        }

        continue;
      }

      // ── Runtime auto-healing (Part B) ──
      // All planned + reviewer-improvement work is done. Boot the app; if it fails
      // with something fixable and we still have cycle/commit/time budget, spawn
      // scoped repair tasks and re-enter THIS loop to run them, then re-check.
      // Runtime healing has its OWN budget (maxRuntimeHealCycles), independent of
      // maxImprovementCycles — booting the app is not the same as polishing code.
      const canHealMore =
        !gracefulDrainRequested &&
        commitsCreated < policy.maxCommits &&
        runtimeHealCycles < policy.maxRuntimeHealCycles;

      if (canHealMore) {
        await checkoutBranch(baseWorkspace.repoPath, run.branchName);

        // If a task changed dependencies, the base node_modules (symlinked into
        // worktrees) may be stale — refresh before booting (Part A2).
        if (depsTouchedDuringRun) {
          await refreshWorkspaceDependencies(baseWorkspace, (m) => {
            if (onProgress) void onProgress(m);
          });
          depsTouchedDuringRun = false;
        }

        if (onProgress) {
          await onProgress(`🌐 Runtime healing check ${runtimeHealCycles + 1}: booting app to verify it runs...`);
        }

        const detailed = await runRuntimeGateDetailed(baseWorkspace, policy, latestTargetRoute, onProgress);
        runtimeResultsFromHealing = detailed.results;
        runtimeHealCycles += 1;

        const runtimePassed = detailed.results.every((g) => g.status !== 'failed');
        if (runtimePassed) {
          break; // app boots — done
        }

        if (hasHealableFailures(detailed.failures)) {
          const repairDrafts = buildRuntimeRepairTasks(detailed.failures);
          unityStore.updateRun(run.id, { status: 'healing' });
          // Label repair tasks by heal round (NOT improvementCycle — separate budget).
          const repairTasks = createImprovementTasks(
            run.id,
            runtimeHealCycles,
            dedupeFollowUpTasks(repairDrafts),
            allTasks.length,
          );
          for (const task of repairTasks) {
            unityStore.createTask(task);
          }
          unityStore.addEvent(
            createEntityId('event'),
            run.id,
            null,
            'warning',
            'run.runtime_healing',
            `Runtime gate failed; created ${repairTasks.length} repair task(s).`,
            { failures: detailed.failures.map((f) => ({ kind: f.kind, detail: f.detail })) },
          );
          if (onProgress) {
            await onProgress(
              `🩹 Runtime failed to boot — created ${repairTasks.length} repair task(s) and retrying. (${detailed.failures.map((f) => f.detail).join('; ')})`,
            );
          }
          continue; // re-enter loop to run repair tasks, then re-check
        }

        // Runtime failed but nothing is safely auto-fixable — stop healing.
        if (onProgress) {
          await onProgress(`⚠️ Runtime gate failed with no auto-fixable cause; leaving as a warning.`);
        }
      }

      break;
    }

    const batch = selectRunnableBatch(readyTasks, policy.maxParallelTasks);
    if (onProgress) {
      await onProgress(`🧠 Scheduling ${batch.length} task(s) in parallel.`);
    }

    const results = await Promise.all(
      batch.map((task) =>
        executeTask(
          task,
          baseWorkspace,
          run,
          figmaData,
          projectMemory,
          policy,
          signal,
          buildDependencyContext(task, allTasks),
          {
            inClosingWindow: budgetState.inClosingWindow,
            remainingMs: budgetState.remainingMs,
          },
          onProgress,
        ),
      ),
    );

    for (const result of results) {
      const task = unityStore.getTask(result.task.id) || result.task;

      if (result.outcome.status === 'succeeded') {
        try {
          if (onProgress) {
            await onProgress(`🔀 [${task.title}] Integrating commit into ${run.branchName}...`);
          }
          await integrateTaskResult(baseWorkspace, run, result);
          commitsCreated += result.outcome.commitSha ? 1 : 0;
          latestTargetRoute = result.targetRoute || latestTargetRoute;
          // Track dependency changes so the runtime healing check can refresh the
          // base node_modules before booting (worktrees symlink the base) (A2).
          if (taskChangedDependencies(task.writeScope, result.diff)) {
            depsTouchedDuringRun = true;
          }
          unityStore.updateTask(task.id, {
            status: 'succeeded',
            commitSha: result.outcome.commitSha || null,
            commitMessage: result.outcome.commitMessage || null,
            outputSummary: result.outcome.outputSummary || null,
            validationSummary: result.outcome.validationSummary || null,
            finishedAt: nowIso(),
          });
          unityStore.addArtifact(
            createEntityId('artifact'),
            run.id,
            task.id,
            'diff',
            result.diff,
            null,
            { taskTitle: task.title },
          );
          unityStore.addEvent(
            createEntityId('event'),
            run.id,
            task.id,
            'info',
            'task.integrated',
            `Task integrated into ${run.branchName}.`,
            {
              commitSha: result.outcome.commitSha,
              commitMessage: result.outcome.commitMessage,
            },
          );

          if (onProgress) {
            await onProgress(
              `✅ [${task.title}] Integrated successfully. Commit budget: ${commitsCreated}/${policy.maxCommits}.`,
            );
          }

          if (!gracefulDrainRequested) {
            pendingImprovementDrafts.push(...result.review.followUpTasks);
          }
        } catch (error: any) {
          const validationSummary = `Integration failed: ${error.message || String(error)}`;
          if (task.attempts < policy.maxRetriesPerTask && !gracefulDrainRequested) {
            unityStore.updateTask(task.id, {
              status: 'pending',
              prompt: buildRetryPrompt(task, validationSummary),
              validationSummary,
            });
            unityStore.addEvent(
              createEntityId('event'),
              run.id,
              task.id,
              'warning',
              'task.retry.integration',
              validationSummary,
            );
            if (onProgress) {
              await onProgress(`⚠️ [${task.title}] Integration failed and will retry. ${validationSummary}`);
            }
          } else {
            unityStore.updateTask(task.id, {
              status: 'failed',
              validationSummary,
              finishedAt: nowIso(),
            });
            unityStore.addEvent(
              createEntityId('event'),
              run.id,
              task.id,
              'error',
              'task.failed.integration',
              validationSummary,
            );
            if (onProgress) {
              await onProgress(`❌ [${task.title}] Integration failed permanently. ${validationSummary}`);
            }
          }
        }

        continue;
      }

      const validationSummary = result.outcome.validationSummary || 'Task failed validation.';
      if (task.attempts < policy.maxRetriesPerTask && !gracefulDrainRequested) {
        unityStore.updateTask(task.id, {
          status: 'pending',
          prompt: buildRetryPrompt(task, validationSummary),
          validationSummary,
        });
        unityStore.addEvent(
          createEntityId('event'),
          run.id,
          task.id,
          'warning',
          'task.retry.validation',
          validationSummary,
        );
        if (onProgress) {
          await onProgress(`⚠️ [${task.title}] Validation failed and will retry. ${validationSummary}`);
        }
      } else {
        unityStore.updateTask(task.id, {
          status: result.outcome.status,
          commitSha: result.outcome.commitSha || null,
          commitMessage: result.outcome.commitMessage || null,
          outputSummary: result.outcome.outputSummary || null,
          validationSummary,
          finishedAt: nowIso(),
        });
        unityStore.addEvent(
          createEntityId('event'),
          run.id,
          task.id,
          'error',
          'task.failed.validation',
          validationSummary,
        );
        if (onProgress) {
          await onProgress(`❌ [${task.title}] Validation failed permanently. ${validationSummary}`);
        }
      }
    }

    if (gracefulDrainRequested) {
      break;
    }
  }

  const endBudgetState = getRunBudgetState(deadline);
  const pendingTasksAfterLoop = unityStore
    .listTasksByRun(run.id)
    .filter((candidate) => candidate.status === 'pending');

  if (endBudgetState.exhausted || commitsCreated >= policy.maxCommits || gracefulDrainRequested) {
    const blockingReason =
      endBudgetState.exhausted
        ? `Run reached the max execution window of ${policy.maxHours} hour(s).`
        : gracefulDrainRequested
          ? `Run entered the final closing window and stopped scheduling new work to finish cleanly.`
          : `Run reached the max commit budget of ${policy.maxCommits}.`;

    if (pendingTasksAfterLoop.length > 0) {
      budgetNote = blockingReason;

      for (const task of pendingTasksAfterLoop) {
        unityStore.updateTask(task.id, {
          status: 'blocked',
          validationSummary: blockingReason,
          finishedAt: nowIso(),
        });
      }

      unityStore.addEvent(
        createEntityId('event'),
        run.id,
        null,
        'warning',
        'run.budget_exhausted',
        blockingReason,
      );
    } else if (commitsCreated >= policy.maxCommits) {
      unityStore.addEvent(
        createEntityId('event'),
        run.id,
        null,
        'info',
        'run.commit_budget_consumed',
        `Run consumed the full commit budget of ${policy.maxCommits} while finishing scheduled work.`,
      );
    }
  }

  await checkoutBranch(baseWorkspace.repoPath, run.branchName);
  if (onProgress) {
    await onProgress(`🧪 Running final static gates on ${run.branchName}...`);
  }
  const finalStaticResults = await runStaticGates(baseWorkspace, policy);
  unityStore.addArtifact(
    createEntityId('artifact'),
    run.id,
    null,
    'final-static-gates',
    JSON.stringify(finalStaticResults, null, 2),
    null,
  );
  if (onProgress) {
    await onProgress(
      `🧪 Final static gates finished. Failed gates: ${
        finalStaticResults.filter((gate) => gate.status === 'failed').map((gate) => gate.name).join(', ') || 'none'
      }.`,
    );
    await onProgress(`🌐 Starting runtime gate for route ${latestTargetRoute}...`);
  }
  // Reuse the runtime result from the healing loop if it already ran the gate;
  // otherwise run it now (e.g. drain/budget paths that skipped healing).
  const runtimeResults =
    runtimeResultsFromHealing ?? (await runRuntimeGate(baseWorkspace, policy, latestTargetRoute, onProgress));
  unityStore.addArtifact(
    createEntityId('artifact'),
    run.id,
    null,
    'runtime-gates',
    JSON.stringify(runtimeResults, null, 2),
    null,
  );
  if (onProgress) {
    await onProgress(
      `🌐 Runtime gate finished. Failed gates: ${
        runtimeResults.filter((gate) => gate.status === 'failed').map((gate) => gate.name).join(', ') || 'none'
      }.`,
    );
  }
  const tasks = unityStore.listTasksByRun(run.id);
  const closure = assessRunClosure(
    plan.tasks.length,
    tasks,
    baselineStaticResults,
    finalStaticResults,
    runtimeResults,
    budgetNote,
  );
  const summary = formatRunSummary(
    run,
    closure,
    tasks,
    commitsCreated,
    budgetNote,
    baselineStaticResults,
    finalStaticResults,
    runtimeResults,
  );
  const runtimeUrlDetails = runtimeResults.find((gate) => gate.name === 'runtime:url')?.details || '';
  const localUrlMatch = runtimeUrlDetails.match(/Local:\s+([^|]+)/);
  const publicUrlMatch = runtimeUrlDetails.match(/Public:\s+(.+)$/);
  unityStore.upsertMemory(
    createEntityId('memory'),
    project.name,
    'continuous_improvement',
    `run:${run.id}:summary`,
    summary,
      {
        commitsCreated,
        successfulTasks: tasks.filter((task) => task.status === 'succeeded' || task.status === 'skipped').length,
        requiredTasksCompleted: closure.requiredTasksCompleted,
        requiredTasksTotal: closure.requiredTasksTotal,
        outcome: closure.status,
        warnings: closure.warnings,
        failures: closure.failures,
      },
  );
  unityStore.addArtifact(
    createEntityId('artifact'),
    run.id,
    null,
    'run-close-report',
    JSON.stringify(
      {
        outcome: closure.status,
        reason: closure.summaryReason,
        warnings: closure.warnings,
        failures: closure.failures,
        requiredTasksCompleted: closure.requiredTasksCompleted,
        requiredTasksTotal: closure.requiredTasksTotal,
        incompleteFollowUpTasks: closure.incompleteFollowUpTasks,
        commitsCreated,
        commitBudget: run.maxCommits,
        budgetNote,
      },
      null,
      2,
    ),
    null,
  );

  // Update Knowledge Graph with file changes from this run
  try {
    const knowledgeGraph = getKnowledgeGraph();
    const changedFiles: Array<{ path: string; taskId?: string; gatePassed: boolean }> = [];
    for (const task of tasks) {
      if (task.commitSha) {
        const taskGatePassed = task.status === 'succeeded';
        const taskFiles = task.outputSummary
          ? extractEditedFiles(task.outputSummary)
          : [];
        // If no files from summary, use writeScope as proxy
        const filePaths = taskFiles.length > 0 ? taskFiles : task.writeScope;
        for (const fp of filePaths) {
          changedFiles.push({ path: fp, taskId: task.id, gatePassed: taskGatePassed });
        }
      }
    }
    if (changedFiles.length > 0) {
      knowledgeGraph.updateAfterRun({
        projectName: project.name,
        runId: run.id,
        changedFiles,
      });
    }
  } catch (kgError) {
    console.warn('[unity] Knowledge graph update failed:', kgError);
  }

  unityStore.updateRun(run.id, {
    status: closure.status,
    finishedAt: nowIso(),
    summary,
  });

  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    closure.status === 'failed' ? 'error' : closure.status === 'completed_with_warnings' ? 'warning' : 'info',
    closure.status === 'failed'
      ? 'run.failed'
      : closure.status === 'completed_with_warnings'
        ? 'run.completed_with_warnings'
        : 'run.completed',
    summary,
  );

  return {
    runId: run.id,
    branchName: run.branchName,
    defaultBranch: run.defaultBranch,
    summary,
    commitsCreated,
    runtimeUrls: {
      localUrl: localUrlMatch ? localUrlMatch[1].trim() : null,
      publicUrl: publicUrlMatch ? publicUrlMatch[1].trim() : null,
    },
    tasks: tasks.map((task) => ({
      title: task.title,
      status: task.status,
      commitMessage: task.commitMessage,
    })),
  };
}

export async function createAutonomousRunPlan({
  project,
  prompt,
  channelName,
  mode = 'interactive',
  signal,
  onProgress,
}: RunAutonomousAgentParams): Promise<CreateAutonomousRunPlanResult> {
  const policy = getProjectPolicy(unityStore, project.name);
  unityStore.upsertPolicy(project.name, policy);

  const baseWorkspace = await prepareWorkspace(project);

  // Auto-populate knowledge graph on first run for a project
  const kg = getKnowledgeGraph();
  if (kg.listModules(project.name).length === 0) {
    kg.scanProjectStructure(project.name, baseWorkspace.repoPath);
  }

  const branchState = await ensureIntegrationBranch(baseWorkspace, policy.integrationBranchName);
  const baselineStaticResults = await runStaticGates(baseWorkspace, policy);
  const runId = createEntityId('run');
  const run = buildRunRecord(
    runId,
    project.name,
    channelName,
    prompt,
    policy,
    branchState.integrationBranch,
    branchState.defaultBranch,
    mode,
  );

  unityStore.createRun(run);
  unityStore.addEvent(createEntityId('event'), run.id, null, 'info', 'run.created', 'Autonomous run created.', {
    project: project.name,
    branch: branchState.integrationBranch,
    branchCreated: branchState.created,
    mode,
  });
  unityStore.addArtifact(
    createEntityId('artifact'),
    run.id,
    null,
    'baseline-static-gates',
    JSON.stringify(baselineStaticResults, null, 2),
    null,
  );

  if (onProgress) {
    await onProgress(
      `🤖 Autonomous run \`${run.id}\` started on \`${branchState.integrationBranch}\`${branchState.created ? ' (branch created upstream)' : ''}.`,
    );
  }

  const projectTree = getProjectTree(baseWorkspace.repoPath);
  const projectMemory = getProjectMemory(baseWorkspace.repoPath);
  unityStore.upsertMemory(createEntityId('memory'), project.name, 'run_context', run.id, prompt, {
    channelName,
    mode,
  });

  if (projectMemory) {
    unityStore.upsertMemory(
      createEntityId('memory'),
      project.name,
      'stable_repo',
      'project_memory',
      projectMemory,
    );
  }

  if (signal?.aborted) {
    throw new Error('AbortError');
  }

  const plan = await planAutonomousRun({
    prompt,
    projectTree,
    projectMemory,
    runId: run.id,
    projectName: project.name,
  });

  const autoApproved = shouldAutoApprovePlan(mode, policy);
  const timestamp = nowIso();
  const planId = createEntityId('plan');

  unityStore.createPlan(planId, run.id, plan.summary, plan, {
    status: autoApproved ? 'approved' : 'proposed',
    version: 1,
    approvedAt: autoApproved ? timestamp : null,
    approvedBy: autoApproved ? 'policy:auto' : null,
  });
  unityStore.addArtifact(createEntityId('artifact'), run.id, null, 'plan', JSON.stringify(plan, null, 2), null);
  unityStore.updateRun(run.id, {
    status: autoApproved ? 'running' : 'awaiting_plan_approval',
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'info',
    autoApproved ? 'plan.auto_approved' : 'plan.created',
    autoApproved
      ? `Plan auto-approved by policy.`
      : `Plan created and awaiting approval in the local console.`,
    {
      planId,
      summary: plan.summary,
    },
  );

  if (onProgress) {
    await onProgress(
      autoApproved
        ? `🗺️ Plan ready and auto-approved: ${plan.summary}`
        : `🗺️ Plan ready: ${plan.summary}`,
    );
  }

  return {
    runId: run.id,
    branchName: run.branchName,
    defaultBranch: run.defaultBranch,
    planSummary: plan.summary,
    consoleUrl: buildConsoleRunUrl(run.id),
    requiresApproval: !autoApproved,
    autoApproved,
    tasks: plan.tasks.map((task) => ({
      title: task.title,
      writeScope: task.writeScope,
      dependencies: task.dependencies || [],
    })),
  };
}

export function approveAutonomousRunPlan(runId: string, approvedBy = 'local-ui'): void {
  const run = unityStore.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const plan = unityStore.getLatestPlanByRun(runId);
  if (!plan) {
    throw new Error(`Run ${runId} has no persisted plan.`);
  }

  if (plan.status === 'approved') {
    return;
  }

  if (plan.status === 'rejected') {
    throw new Error(`Run ${runId} has a rejected plan and cannot be approved without replanning.`);
  }

  const timestamp = nowIso();
  unityStore.updatePlan(plan.id, {
    status: 'approved',
    approvedAt: timestamp,
    approvedBy,
    rejectedAt: null,
    rejectedBy: null,
    rejectedReason: null,
  });
  unityStore.updateRun(run.id, {
    status: 'running',
    finishedAt: null,
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'info',
    'plan.approved',
    `Plan approved by ${approvedBy}.`,
  );
}

export function rejectAutonomousRunPlan(
  runId: string,
  rejectedBy = 'local-ui',
  rejectedReason = 'Plan rejected from the local console.',
): void {
  const run = unityStore.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const plan = unityStore.getLatestPlanByRun(runId);
  if (!plan) {
    throw new Error(`Run ${runId} has no persisted plan.`);
  }

  if (plan.status === 'approved' || run.status === 'running' || run.status === 'healing' || run.status === 'completed') {
    throw new Error(`Run ${runId} has already moved past the approval stage.`);
  }

  const timestamp = nowIso();
  unityStore.updatePlan(plan.id, {
    status: 'rejected',
    rejectedAt: timestamp,
    rejectedBy,
    rejectedReason,
  });
  unityStore.updateRun(run.id, {
    status: 'plan_rejected',
    finishedAt: timestamp,
    summary: rejectedReason,
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'warning',
    'plan.rejected',
    rejectedReason,
    {
      rejectedBy,
    },
  );
}

export async function resumeAutonomousRun({
  runId,
  signal,
  onProgress,
}: ResumeAutonomousRunParams): Promise<RunAutonomousAgentResult> {
  const run = unityStore.getRun(runId);
  if (!run) {
    throw new Error(`Run ${runId} was not found.`);
  }

  const planRecord = unityStore.getLatestPlanByRun(runId);
  if (!planRecord) {
    throw new Error(`Run ${runId} has no persisted plan.`);
  }

  if (planRecord.status !== 'approved') {
    throw new Error(`Run ${runId} is not approved yet.`);
  }

  const project = getProjectByName(run.projectName);
  const policy = getProjectPolicy(unityStore, project.name);
  unityStore.upsertPolicy(project.name, policy);

  const baseWorkspace = await prepareWorkspace(project);

  // Auto-populate knowledge graph on first run for a project
  const kgResume = getKnowledgeGraph();
  if (kgResume.listModules(project.name).length === 0) {
    kgResume.scanProjectStructure(project.name, baseWorkspace.repoPath);
  }

  await ensureIntegrationBranch(baseWorkspace, run.branchName);
  let baselineStaticResults = loadBaselineStaticResults(runId);
  if (baselineStaticResults.length === 0) {
    baselineStaticResults = await runStaticGates(baseWorkspace, policy);
    unityStore.addArtifact(
      createEntityId('artifact'),
      run.id,
      null,
      'baseline-static-gates',
      JSON.stringify(baselineStaticResults, null, 2),
      null,
    );
  }

  // ── Checkpoint recovery: reset interrupted tasks ──
  const isResumeFromCrash = run.status === 'running' || run.status === 'healing';
  if (isResumeFromCrash) {
    const resetCount = unityStore.resetInterruptedTasks(run.id);
    const progress = unityStore.getRunProgress(run.id);

    if (resetCount > 0 || progress.completed > 0) {
      unityStore.addEvent(
        createEntityId('event'),
        run.id,
        null,
        'info',
        'run.checkpoint_resume',
        `Resuming from checkpoint: ${progress.completed} tasks already completed, ${resetCount} interrupted tasks reset to pending, ${progress.pending} tasks remaining.`,
      );

      if (onProgress) {
        await onProgress(
          `🔄 Resuming from checkpoint: ${progress.completed} tasks done, ${resetCount} reset, ${progress.pending} remaining.`,
        );
      }
    }
  }

  unityStore.updateRun(run.id, {
    status: 'running',
    finishedAt: null,
  });
  unityStore.addEvent(
    createEntityId('event'),
    run.id,
    null,
    'info',
    'run.resumed',
    isResumeFromCrash ? 'Run resumed from crash checkpoint.' : 'Run resumed after plan approval.',
  );

  if (onProgress) {
    await onProgress(`🚀 Resuming run \`${run.id}\` on \`${run.branchName}\`.`);
  }

  return executeApprovedRun(
    unityStore.getRun(run.id) || run,
    project,
    planRecord.rawPlan,
    policy,
    baseWorkspace,
    baselineStaticResults,
    signal,
    onProgress,
  );
}

/**
 * Scan for runs that were interrupted by a crash and can be resumed.
 */
export function listResumableRuns(): Array<{
  runId: string;
  projectName: string;
  prompt: string;
  progress: { total: number; completed: number; failed: number; pending: number };
}> {
  const runs = unityStore.listResumableRuns();

  return runs.map((run) => ({
    runId: run.id,
    projectName: run.projectName,
    prompt: run.prompt,
    progress: unityStore.getRunProgress(run.id),
  }));
}

export async function runAutonomousAgent(
  params: RunAutonomousAgentParams,
): Promise<RunAutonomousAgentResult> {
  const planned = await createAutonomousRunPlan(params);

  if (planned.requiresApproval) {
    throw new Error(
      `Run ${planned.runId} is waiting for plan approval. Use createAutonomousRunPlan + resumeAutonomousRun for interactive flows.`,
    );
  }

  return resumeAutonomousRun({
    runId: planned.runId,
    signal: params.signal,
    onProgress: params.onProgress,
  });
}
