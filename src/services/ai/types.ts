export interface FileEdit {
  filepath: string;
  search: string;
  replace: string;
}

export interface AIResponse {
  targetRoute: string;
  commitMessage: string;
  edits: FileEdit[];
}

export interface ValidationResult {
  rawOutput: string;
  normalizedErrors: Set<string>;
}

export interface BuildSystemPromptParams {
  userPrompt: string;
  figmaData: string | null;
  projectTree: string;
  projectMemory: string | null;
  currentDiff: string | null;
  /** Learned patterns from previous successful runs (injected by learning loop) */
  learnedPatterns?: string | null;
  /** Pre-computed context from the Explorer→Architect pipeline */
  architectContext?: string | null;
  /** Summary of pre-existing gate failures so the agent doesn't try to fix them */
  baselineFailures?: string | null;
}

export interface GenerateCodeParams extends BuildSystemPromptParams {
  repoPath: string;
  onStatusUpdate?: (status: string, thought?: string) => void;
  /** Stream per-iteration chain-of-thought from the model (when available). */
  onThinking?: (iteration: number, reasoning: string) => void;
  signal?: AbortSignal;
  /** For token budget tracking */
  runId?: string;
  taskId?: string;
  /** Project name for telemetry attribution */
  projectName?: string;
  /** Pre-computed context from the Explorer→Architect pipeline */
  architectContext?: string | null;
}

