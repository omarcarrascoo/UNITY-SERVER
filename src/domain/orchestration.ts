export type AgentRole =
  | 'orchestrator'
  | 'planner'
  | 'executor'
  | 'reviewer'
  | 'measurer'
  | 'memory-curator';

export type RunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'healing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'skipped';

export type TaskKind =
  | 'implement'
  | 'review'
  | 'measure'
  | 'improve'
  | 'heal'
  | 'memory';

export type MemoryLayer = 'stable_repo' | 'run_context' | 'continuous_improvement';

export interface RunRecord {
  id: string;
  projectName: string;
  channelName: string;
  prompt: string;
  status: RunStatus;
  mode: 'interactive' | 'nightly';
  branchName: string;
  defaultBranch: string;
  maxParallelTasks: number;
  maxRetriesPerTask: number;
  maxImprovementCycles: number;
  maxHours: number;
  maxCommits: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary?: string | null;
}

export interface TaskRecord {
  id: string;
  runId: string;
  parentTaskId?: string | null;
  title: string;
  prompt: string;
  role: AgentRole;
  kind: TaskKind;
  status: TaskStatus;
  writeScope: string[];
  dependencies: string[];
  attempts: number;
  branchName?: string | null;
  worktreePath?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  outputSummary?: string | null;
  validationSummary?: string | null;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface PlanTaskDraft {
  title: string;
  prompt: string;
  role: Extract<AgentRole, 'executor'>;
  kind: Extract<TaskKind, 'implement' | 'improve' | 'heal'>;
  writeScope: string[];
  dependencies?: string[];
  rationale?: string;
}

export interface RunPlanDraft {
  summary: string;
  tasks: PlanTaskDraft[];
}

export interface ReviewFinding {
  severity: 'low' | 'medium' | 'high';
  message: string;
  file?: string;
}

export interface ReviewResult {
  approved: boolean;
  summary: string;
  findings: ReviewFinding[];
  followUpTasks: PlanTaskDraft[];
}

export interface GateResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  details: string;
}

export interface TaskExecutionOutcome {
  taskId: string;
  status: TaskStatus;
  commitSha?: string;
  commitMessage?: string;
  outputSummary?: string;
  validationSummary?: string;
  gates: GateResult[];
  targetRoute?: string;
  tokenUsage?: number;
}

