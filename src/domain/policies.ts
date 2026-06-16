export interface GatePolicy {
  runTypecheck: boolean;
  runLint: boolean;
  runTests: boolean;
  runBuild: boolean;
  runRuntime: boolean;
  requireRuntimeForUi: boolean;
  captureSnapshot: boolean;
  /** Scan for hardcoded secrets/credentials in scope */
  runSecurityScan: boolean;
  /** Detect circular import chains in scope */
  runImportCycleCheck: boolean;
}

export interface AutonomousRunPolicy {
  integrationBranchName: string;
  autoApprovePlan: boolean;
  maxParallelTasks: number;
  maxRetriesPerTask: number;
  maxImprovementCycles: number;
  /**
   * Max runtime auto-healing rounds (boot the app, fix what stops it from
   * starting, retry). INDEPENDENT of maxImprovementCycles — getting the app to
   * boot at all is not the same as polishing working code. 0 disables healing.
   */
  maxRuntimeHealCycles: number;
  maxHours: number;
  maxCommits: number;
  /** Max tokens across all tasks in a single run (0 = unlimited) */
  maxTokensPerRun: number;
  /** Max tokens for a single task execution (0 = unlimited) */
  maxTokensPerTask: number;
  /** Max minutes per task attempt (0 = unlimited). Prevents one task from consuming the run window. */
  maxMinutesPerTask: number;
  gates: GatePolicy;
}

export interface NightJobConfig {
  maxHours: number;
  maxCommits: number;
  maxParallelTasks: number;
  maxRetriesPerTask: number;
}
