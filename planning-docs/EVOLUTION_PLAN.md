# Unity Agent — Evolution Plan

> Taking brain-station from working POC to production-grade autonomous dev orchestrator.
>
> **Last updated**: 2026-04-08 (Phase 0-8 complete — ALL PHASES DONE)

---

## Current State Assessment

### What's Solid
- Worktree isolation per task (git-level separation)
- Baseline-delta gate comparison (regression detection)
- SQLite persistence for full run observability
- Two-channel Discord architecture (manual + autonomous)
- Plan → Approve → Execute → Review → Integrate loop
- Write scope enforcement (tasks can't touch files outside their lane)
- Project scaffolding (Expo / NestJS / Fullstack)
- Figma context injection
- Runtime gates for Expo/NestJS startup verification

### The 3 Structural Bottlenecks (all addressed in Phase 0-2)

1. ~~**The agent is blind** — only 3 primitive tools~~ → **RESOLVED**: 8 tools including regex grep, find_references, list_directory, run_tests, write_file
2. ~~**Edit mechanism is fragile** — exact string matching breaks on whitespace differences~~ → **RESOLVED**: Fuzzy matching fallback (85% threshold), line-range editing, atomic rollback
3. ~~**Loop heuristics are hardcoded** — project-specific keywords baked in~~ → **RESOLVED**: Adaptive information gain tracking, spiral detection, progressive iteration pressure

---

## Phase 0 — Critical Fixes ✅ COMPLETED

### 0.1 Fix Shell Injection in git.ts ✅
- Replaced `execPromise` string interpolation with `execFilePromise` array args
- All git operations in `createPullRequest()` now use `execFile` — commit messages, branch names, and remote URLs can no longer inject shell commands
- **File changed**: `src/git.ts`

### 0.2 Add Database Indexes ✅
- Added 10 indexes on hot query paths:
  - `idx_tasks_run_id`, `idx_tasks_status`
  - `idx_events_run_id`, `idx_events_task_id`
  - `idx_artifacts_run_id`, `idx_artifacts_task_id`
  - `idx_plans_run_id`
  - `idx_runs_status_created`, `idx_runs_project_name`
  - `idx_night_jobs_project`
- All use `IF NOT EXISTS` for safe re-runs on existing databases
- **File changed**: `src/services/persistence/unity-store.ts`

### 0.3 Fix Worktree Cleanup Race Condition ✅
- Added `WorktreeMutex` class — async mutex with FIFO queue
- Both `createTaskWorktree()` and `removeTaskWorktree()` acquire the mutex before any git worktree operations
- `finally` block ensures mutex is always released, even on errors
- **File changed**: `src/services/orchestration/worktree-manager.ts`

---

## Phase 1 — Agent Intelligence ✅ COMPLETED (partial — 1.2 deferred)

### 1.1 Upgrade Agent Tool Runtime ✅
- **5 new tools added** to the agent toolkit:
  - `grep_code` — regex search with context lines (0-5), file glob filtering, up to 100 results
  - `list_directory` — recursive tree with depth control (up to 6), file sizes, glob filtering
  - `find_references` — categorized import/usage tracking for any symbol across `.ts/.tsx/.js/.jsx`
  - `run_tests` — targeted test execution with auto-detection of Jest/Vitest, longer timeout (60s default), proper CI env
  - `write_file` — mid-loop file creation/overwriting with path safety and directory auto-creation
- **Existing tools improved**:
  - `read_file` — default line limit bumped from 300 → 500, output now shows total line count
  - `search_project` — matches per file bumped from 3 → 5, extended source file regex to include `.css/.scss/.html/.yaml/.graphql/.prisma/.sql`
  - `run_command` — timeout bumped from 20s → 30s, added `npx jest` and `npx vitest` to allowed commands
- **Architecture**: Unified `executeTool()` dispatcher replaces individual method calls. Agent runner updated to use it.
- **Files changed**: `src/tools.ts`, `src/services/ai/agent-runner.ts`

### 1.2 Build Semantic Code Index — DEFERRED
- Requires TypeScript compiler API integration (`ts.createProgram`)
- Current `find_references` provides 80% of the value with regex-based import/usage tracking
- Will revisit when agent performance data shows the remaining 20% is a bottleneck
- **Status**: Backlog — implement when telemetry (Phase 6) shows search iterations are still high

### 1.3 Make Loop Heuristics Project-Agnostic ✅
- **Removed** all hardcoded keywords (`KuboHomeHeader`, `register-studio`, `register`, `menu`, `origin`)
- **Added** spiral detection — detects repeated tool call sequences (3-cycle repeat or 4+ identical calls)
- **Added** information gain tracking — measures whether recent tool calls are discovering new files or re-reading old ones (`high`/`low`/`stale`)
- **Added** evidence scoring — adaptive check based on unique files read + searches performed (threshold: 2 files + 1 search, combined score ≥ 4)
- **Added** progressive iteration pressure — gentle nudge at 15 iterations, firm at 25, hard limit at 100
- **Single entry point**: `evaluateLoopControl(toolHistory, iterationCount, totalTokens)` returns `{ shouldRedirect, reason }`
- **File changed**: `src/services/ai/loop-heuristics.ts`, `src/services/ai/agent-runner.ts`

---

## Phase 2 — Edit Reliability ✅ COMPLETED

### 2.1 Line-Range Based Editing ✅
- Edits with `startLine`/`endLine` fields are detected and applied as line splices
- Falls through to search/replace mode when line-range fields are absent
- **File changed**: `src/services/ai/edit-operations.ts`

### 2.2 Fuzzy Matching Fallback ✅
- When exact search block has 0 matches, triggers fuzzy matching pipeline:
  1. Normalizes whitespace (collapse runs of spaces/tabs)
  2. Slides a window across file lines (±1 line for slight misalignment)
  3. Computes line-based similarity ratio (threshold: 85%)
  4. Verifies fuzzy match is unique in the file before applying
  5. Logs when fuzzy match is used for transparency
- If fuzzy match also fails, error message now tells agent to `read_file` first
- **File changed**: `src/services/ai/edit-operations.ts`

### 2.3 Atomic Edit Transactions ✅
- Before applying any edits, all target files are snapshotted (content + existence state)
- If ANY edit in the batch fails, ALL files are rolled back to their pre-edit state
- New files created during a failed batch are deleted
- Agent retries with a clean filesystem, not a half-applied mess
- **File changed**: `src/services/ai/edit-operations.ts`

---

## Phase 3 — Orchestration Robustness ✅ COMPLETED

### 3.1 Cherry-Pick Conflict Resolution ✅
- `cherryPickCommit()` now returns a structured `CherryPickResult` with `success`, `conflicting`, `conflictFiles`, and `error`
- On conflict: attempts auto-resolution by accepting "theirs" (incoming cherry-picked version) for each conflicting file
- If auto-resolve succeeds and all conflicts cleared: runs `cherry-pick --continue` automatically
- If auto-resolve fails: aborts cleanly and returns detailed conflict file list
- `predictCherryPickConflict()` added for dry-run pre-checks (not yet wired into main loop — available for future use)
- Also fixed shell injection in `commitAllChanges()` — now uses `execFilePromise` with array args
- `integrateTaskResult()` updated to handle the new result structure with proper error messages
- **Files changed**: `src/services/orchestration/branch-manager.ts`, `src/application/run-autonomous-agent.ts`

### 3.2 Real Task Queue with Backpressure ✅
- New `TaskQueue<T>` class with:
  - Priority levels: `critical`, `normal`, `low` — queue sorted by priority
  - Configurable concurrency slots (default 6)
  - Per-task timeout watchdog (kills via AbortController on timeout)
  - `cancel(taskId)` — cancel specific task (running or pending)
  - `cancelByProject(projectName)` — cancel all tasks for a project
  - `drain()` — graceful shutdown: cancel pending, wait for running to finish
  - `getMetrics()` — snapshot of pending/running counts and elapsed times
- `RuntimeState` upgraded:
  - Supports multiple concurrent runs via `activeRuns` map (replacing single boolean)
  - `startProcessing(runId?, projectName?)` — backward-compatible, generates legacy ID when called without args
  - `isProjectProcessing(projectName)` — check if specific project is busy
  - `abortByProject(projectName)` — abort all runs + queue tasks for a project
  - `getQueueMetrics()` — combined view of active runs + queue state
- **Files changed**: New `src/runtime/task-queue.ts`, rewritten `src/runtime/state.ts`

### 3.3 Checkpoint & Resume ✅
- New `UnityStore` methods:
  - `listResumableRuns()` — finds runs with status `running` or `healing` (interrupted by crash)
  - `getRunProgress(runId)` — returns `{ total, completed, failed, pending }` task counts
  - `resetInterruptedTasks(runId)` — resets `running` tasks back to `pending`, clears stale worktree/branch refs
- `resumeAutonomousRun()` now detects crash-interrupted runs and:
  - Resets interrupted tasks to pending
  - Logs checkpoint progress (X done, Y reset, Z remaining)
  - Emits `run.checkpoint_resume` event
  - Skips already-completed tasks automatically (existing logic handles this via `succeededTaskIds` set)
- New `listResumableRuns()` export for UI/console to display resumable runs on startup
- **Files changed**: `src/services/persistence/unity-store.ts`, `src/application/run-autonomous-agent.ts`

### 3.4 Isolated node_modules Per Task ✅
- Implemented **Option C**: detect when task write scope includes dependency files
- `taskMayModifyDependencies(writeScope)` checks for `package.json`, lock files in scope
- When detected: runs `npm install --prefer-offline` in each worktree package dir instead of symlinking
- When not detected: symlinks as before (fast, zero overhead)
- `createTaskWorktree()` now accepts optional `writeScope` parameter
- Call site in `executeTask()` updated to pass `task.writeScope`
- **Files changed**: `src/services/orchestration/worktree-manager.ts`, `src/application/run-autonomous-agent.ts`

---

## Phase 4 — Multi-Model Strategy ✅ COMPLETED

> Cut costs by 60%+, speed up exploration phase.

### 4.1 Model Router ✅
- New `AgentRole` type with 5 roles: `planning`, `code-gen`, `review`, `pr-metadata`, `repair`
- Each role maps to a `ModelConfig` with: model, provider, temperature, maxTokens, tier
- Default mapping: all roles run on `deepseek-v4-pro`; reasoning tier (code-gen/pr-metadata/architect) enables thinking mode with `reasoning_effort`, chat tier (planning/review/repair/explorer) disables it
- `configureModelRouter()` allows runtime overrides (e.g., from env vars or policy)
- **File created**: `src/services/ai/model-router.ts`

### 4.2 Provider Abstraction ✅
- New `LLMProvider` interface with `complete(request)` and `isAvailable()` methods
- Normalized request/response types (`LLMCompletionRequest`, `LLMCompletionResponse`) decouple call sites from OpenAI SDK types
- `DeepSeekProvider` wraps existing `client.ts` retry logic
- `ProviderRegistry` with `resolveProvider()` — picks preferred provider, falls back to next available if unavailable
- `setFallbackOrder()` configures failover priority
- New `roleCompletion(role, request)` — unified entry point combining model router + provider registry + token tracking
- **All 5 call sites migrated** from `createDeepseekChatCompletion` to `roleCompletion`:
  - `agent-runner.ts` → role `code-gen`
  - `pr-metadata.ts` → role `pr-metadata`
  - `planner.ts` → role `planning`
  - `reviewer.ts` → role `review` (primary) + `repair` (JSON fix-up)
- **Files created**: `src/services/ai/providers/types.ts`, `src/services/ai/providers/deepseek-provider.ts`, `src/services/ai/providers/provider-registry.ts`, `src/services/ai/providers/index.ts`, `src/services/ai/completion.ts`
- **Files changed**: `src/services/ai/agent-runner.ts`, `src/services/ai/pr-metadata.ts`, `src/services/orchestration/planner.ts`, `src/services/orchestration/reviewer.ts`

### 4.3 Token Budget Tracking ✅
- New `TokenTracker` class with per-run and per-task token accumulation
- `record(runId, taskId, tokens)` returns `BudgetCheck` with status: `ok` | `warning` | `exceeded`
- Warning emitted at 75% of budget (configurable via `warningThreshold`)
- Hard-stop throws error at 100% — caught by orchestrator, task marked as failed
- Added `maxTokensPerRun` (default 2M) and `maxTokensPerTask` (default 500K) to `AutonomousRunPolicy`
- Policy engine defaults and normalization updated
- Agent runner passes `runId`/`taskId` to `roleCompletion` for automatic tracking
- `GenerateCodeParams` extended with optional `runId`/`taskId` fields
- Autonomous agent call site updated to pass run/task context
- **Files created**: `src/services/ai/token-tracker.ts`
- **Files changed**: `src/domain/policies.ts`, `src/services/orchestration/policy-engine.ts`, `src/services/ai/types.ts`, `src/application/run-autonomous-agent.ts`

---

## Phase 5 — Gate System Evolution ✅ COMPLETED

> Make quality gates framework-agnostic and more comprehensive.

### 5.1 Configurable Runtime Gates ✅
- New `RuntimeGateManifest` and `RuntimeServiceConfig` types define services declaratively
- **Auto-detection** for Expo, NestJS, Next.js, Vite, and generic Node.js backends — backward-compatible with existing workspace structure
- **Manual config** via `.unity/gates.json` — define services with custom `startCommand`, `readySignal`, `port`, `timeoutMs`, `healthCheck`, and environment variables
- `resolveRuntimeManifest()` tries manual config first, falls back to auto-detection
- Services started in order: backends first, frontends second. Backend URL auto-injected into frontend `.env`
- Refactored `runProjectRuntimeGate()` to be fully config-driven — no more hardcoded Expo/NestJS logic in the main function
- **Files created**: `src/services/orchestration/runtime-gate-config.ts`
- **Files changed**: `src/services/orchestration/runtime-gate.ts`

### 5.2 New Gate Types ✅
- **Security scan gate** (`security-scan`): Detects hardcoded secrets (API keys, private keys, GitHub tokens, AWS keys, JWTs, passwords) with pattern matching. Allowlist for `.env.example`, test files, mocks, fixtures.
- **Import cycle gate** (`import-cycles`): Builds a dependency graph from `import`/`require` statements, then runs DFS cycle detection. Reports all circular chains with file paths.
- Added `runSecurityScan` and `runImportCycleCheck` flags to `GatePolicy` (both default `true`)
- Default policy engine updated with new gate defaults
- **Files changed**: `src/services/orchestration/gates.ts`, `src/domain/policies.ts`, `src/services/orchestration/policy-engine.ts`

### 5.3 Parallel Gate Execution ✅
- Refactored `runStaticGates()` from sequential `for` loop to `Promise.all()` — all gates (typecheck, lint, test, build, security, import-cycle) run concurrently
- **Per-gate timeouts** replace the old global 120s timeout:
  - typecheck/tsc: 90s
  - lint: 60s
  - test: 180s (tests need more time)
  - build: 120s
- If one gate hangs or times out, all others still complete and report results
- Timeout detection in `runGateCommand` — reports "Gate timed out" with the specific timeout value
- Synchronous gates (security scan, import cycles) run alongside async subprocess gates
- **Files changed**: `src/services/orchestration/gates.ts`

---

## Phase 6 — Observability & Learning ✅ COMPLETED

> You can't improve what you can't measure.

### 6.1 Structured Telemetry ✅
- New `TelemetryStore` class with dedicated SQLite database (`unity-telemetry.sqlite`)
- Typed `TelemetryEvent` with: runId, taskId, event name, duration, token breakdown (input/output/total), estimated cost, model, status, metadata
- Built-in cost estimation using per-model pricing (DeepSeek reasoner $2.19/M, chat $0.27/M, Claude tiers)
- Aggregate queries: `getRunCostSummary()`, `getTaskCosts()`, `getProjectStats()`, `listEventsByRun()`
- High-level `telemetry` API with semantic methods: `taskStarted`, `taskCompleted`, `taskFailed`, `gatePassed`, `runStarted`, `runCompleted`, `editApplied`, `editFailed`
- **Files created**: `src/services/telemetry/telemetry-store.ts`, `src/services/telemetry/index.ts`

### 6.2 Cost Dashboard API ✅
- New HTTP API endpoints:
  - `GET /api/runs/:id/cost` — run cost summary + per-task cost breakdown with model breakdown
  - `GET /api/telemetry/stats?project=X&days=30` — project-level stats (total runs, tokens, cost, success rate)
  - `GET /api/runs/:id/telemetry?limit=200` — raw telemetry events for a run
  - `GET /api/learning/patterns?limit=20` — top learned patterns by effectiveness
  - `GET /api/learning/stats?project=X` — learning system stats (patterns, applications, success rate)
- **Files changed**: `src/transports/http/server.ts`

### 6.3 Learning Loop ✅ (deep implementation)
- **Learning Store** (`src/services/learning/learning-store.ts`):
  - Dedicated SQLite database (`unity-learning.sqlite`)
  - `patterns` table: stores approach summaries, file patterns, tags, tool usage, iteration counts, token usage
  - `pattern_outcomes` table: tracks every time a pattern is applied and whether the task succeeded
  - `effectivenessScore`: computed as `(successes - failures) / applications` — updated on every outcome
  - Relevance scoring: multi-factor matching (project 30%, task kind 20%, scope overlap 25%, keyword overlap 25%, effectiveness bonus 10%)
  - `findRelevantPatterns()` — retrieves and ranks patterns for a task context
  - `pruneIneffectivePatterns()` — removes patterns with score < -0.5 after 3+ applications
  - `deduplicatePatterns()` — merges patterns with same project/kind/scope, keeps best
  - `getTopPatterns()`, `getProjectLearningStats()` for dashboard

- **Pattern Extractor** (`src/services/learning/pattern-extractor.ts`):
  - After a task succeeds all gates, extracts a `LearnedPattern`
  - Keyword extraction from task prompt (stop-word filtered, frequency-ranked)
  - File pattern computation (longest common prefix of edited files)
  - Tool frequency analysis (top 5 most-used tools)
  - **LLM-generated approach summary** — uses `roleCompletion('repair')` to generate a 2-3 sentence natural language summary of what worked. Falls back to structured template if LLM fails
  - Deduplication check: skips extraction if a very similar pattern already exists (relevance > 0.85)
  - Filters trivial tasks (0 edits, 1 iteration + 1 file)

- **Prompt Injector** (`src/services/learning/prompt-injector.ts`):
  - `buildLearningContext()` — finds relevant patterns and formats them as a prompt section
  - Formats patterns as numbered guidance with effectiveness scores, key files, and tool recommendations
  - Returns `appliedPatternIds` for later outcome tracking
  - `recordPatternOutcomes()` — updates effectiveness scores for all applied patterns
  - Probabilistic maintenance: ~10% of recordings trigger pruning + deduplication

- **Full orchestration integration** (`src/application/run-autonomous-agent.ts`):
  - Before each task: `buildLearningContext()` retrieves matching patterns
  - Patterns injected into system prompt via new `learnedPatterns` param in `BuildSystemPromptParams`
  - After successful task: `extractPattern()` creates a new pattern from the execution trace
  - After every task (success or failure): `recordPatternOutcomes()` updates effectiveness scores
  - Logs pattern injection count per task

- **Prompt builder** updated with `📚 LEARNED PATTERNS` section injection
- **Files created**: `src/services/learning/learning-store.ts`, `src/services/learning/pattern-extractor.ts`, `src/services/learning/prompt-injector.ts`, `src/services/learning/index.ts`
- **Files changed**: `src/services/ai/types.ts`, `src/services/ai/prompt-builder.ts`, `src/application/run-autonomous-agent.ts`, `src/transports/http/server.ts`

---

## Phase 7 — Transport & UX ✅ COMPLETED

> Make the system pleasant to operate.

### 7.1 Discord Improvements ✅
- **Policy presets**: `/policy preset:conservative|balanced|aggressive` — three named presets that configure all numeric policy params at once
- **Enhanced `/status` command**: Shows queue metrics (running/pending), active run IDs, token budget, gate flags
- **New `/cost` command**: Shows run cost summary with model breakdown directly in Discord
- **New `/learning` command**: Shows learned pattern stats and top 5 patterns for the active project
- **Elapsed time in progress**: Autonomous run thread messages now include `⏱ Xm Ys —` prefix for real-time duration tracking
- **Files changed**: `src/transports/discord/register-handlers.ts`, `src/services/orchestration/policy-engine.ts`

### 7.2 HTTP Console Upgrades ✅
- **Diff viewer**: New `GET /api/runs/:id/diff` endpoint returns git diff for a run's branch. Full diff modal in the run page UI with syntax-highlighted additions/deletions/hunks
- **Re-run failed tasks**: New `POST /api/runs/:id/rerun-failed` endpoint resets failed tasks to `pending` with `attempts: 0`. "Re-run Failed Tasks" button appears in UI when run status is `failed` or `completed_with_warnings`
- **Task timeline API**: New `GET /api/runs/:id/timeline` endpoint returns task execution timeline with start/finish times and computed durations
- **View Diff button**: Appears on completed/failed runs, opens a modal overlay with color-coded diff output
- **Files changed**: `src/transports/http/server.ts`

### 7.3 Webhook Triggers ✅
- **GitHub webhook handler**: `POST /webhooks/github` endpoint processes GitHub webhook events with HMAC-SHA256 signature verification
- **PR/Issue comment trigger**: Comments containing `/unity run <prompt>` automatically create an autonomous run
- **Push event trigger**: Pushes to configured branches (via `UNITY_TRIGGER_BRANCHES` env var) trigger validation runs
- **Auto mode**: Added `'auto'` to `RunMode` type for webhook-initiated runs that auto-approve and start immediately
- **Configuration**: `UNITY_WEBHOOK_SECRET`, `UNITY_TRIGGER_BRANCHES`, `UNITY_WEBHOOK_PR_COMMENTS`, `UNITY_WEBHOOK_PUSH` env vars
- **Files created**: `src/transports/webhooks/github-handler.ts`, `src/transports/webhooks/index.ts`
- **Files changed**: `src/transports/http/server.ts`, `src/domain/orchestration.ts`

---

## Phase 8 — Advanced Architecture ✅ COMPLETED

> Long-term plays that compound over time.

### 8.1 Multi-Agent Specialization ✅

Splits the monolithic code-gen agent into a specialized pipeline: **Explorer → Architect → Implementer → Reviewer**.

| Agent | Role | Model Tier | Tool Set |
|-------|------|------------|----------|
| **Explorer** | Read-only codebase analysis | chat | `read_file`, `grep_code`, `search_project`, `list_directory`, `find_references`, `run_command` |
| **Architect** | Pure reasoning design | reasoning | No tools (structured JSON plan output) |
| **Implementer** | Write code changes | reasoning | `read_file`, `grep_code`, `search_project`, `write_file`, `run_tests`, `run_command` |
| **Reviewer** | Validate results | chat | No tools (existing reviewer) |

- **Explorer** produces a structured `ExplorationReport` with entry points, patterns, dependencies, risks, approach, and key snippets
- **Architect** takes the exploration report and produces an `ArchitectPlan` with step-by-step file changes, test strategy, and commit message
- **Implementer** receives enriched context (exploration + architect plan) injected into the system prompt alongside learned patterns
- Pipeline is **non-blocking**: if Explorer/Architect fail, Implementer proceeds with direct implementation
- New model router roles: `'explorer'` (chat tier) and `'architect'` (reasoning tier)
- Scoped tool sets per role — Explorer gets read-only tools, Implementer gets write tools
- **Files created**: `src/services/ai/agent-roles.ts`
- **Files changed**: `src/services/ai/model-router.ts`, `src/services/ai/prompt-builder.ts`, `src/services/ai/agent-runner.ts`, `src/services/ai/types.ts`, `src/domain/orchestration.ts`, `src/application/run-autonomous-agent.ts`

### 8.2 Multi-Repo Orchestration ✅

Support for coordinated autonomous runs across multiple repositories.

- **Multi-repo planner** (`planMultiRepoRun`): Takes a list of `RepoDescriptor` objects (name, role, description) and generates a `MultiRepoPlan` with per-repo task lists and cross-repo dependencies
- **Cross-repo dependency resolution** (`resolveMultiRepoExecutionOrder`): Topological sort (Kahn's algorithm) produces a phased execution order across repos, respecting both intra-repo and cross-repo dependencies
- **Coordinated PR builder** (`buildCoordinatedPrBody`): Generates PR descriptions that link all related PRs across repos with a shared plan summary
- **Config loading**: `.unity/repos.json` defines the multi-repo topology (repos, roles, contract files)
- **Files created**: `src/services/orchestration/multi-repo.ts`

### 8.3 Persistent Project Knowledge Graph ✅

A living, SQLite-backed knowledge graph that evolves with each run.

- **Dedicated database**: `unity-knowledge.sqlite` with tables for modules, API endpoints, architecture decisions, and file change logs
- **Module tracking**: Tracks module boundaries, types (service/component/util/config/test/route/domain/infra), exports, dependencies, dependents
- **Hot file detection**: `getHotFiles()` returns most frequently changed files with failure counts
- **Fragility scoring**: `fragilityScore = failureFrequency / changeFrequency` — identifies modules that break often when modified
- **API surface tracking**: Stores endpoints (method, path, source file, consumers)
- **Architecture Decision Records**: Store decisions with context, affected paths, and source run ID
- **Automatic post-run update**: `updateAfterRun()` called at run closure — records file changes, updates module change/failure frequencies, auto-infers module types
- **Planner context injection**: `buildPromptContext()` generates a concise summary (fragile areas, hot files, API surface, decisions) for injection into the Explorer agent prompt
- **HTTP API endpoints**:
  - `GET /api/knowledge/snapshot?project=X` — full knowledge graph snapshot
  - `GET /api/knowledge/hot-files?project=X` — frequently changed files
  - `GET /api/knowledge/fragile?project=X` — fragile module areas
  - `GET /api/knowledge/decisions?project=X` — architecture decisions
  - `POST /api/knowledge/decisions` — add a new architecture decision
- **Files created**: `src/services/knowledge/knowledge-graph.ts`, `src/services/knowledge/index.ts`
- **Files changed**: `src/application/run-autonomous-agent.ts`, `src/transports/http/server.ts`, `src/services/ai/agent-roles.ts`

---

## Progress Tracker

| Phase | Status | Items Done | Key Deliverable |
|-------|--------|------------|-----------------|
| **Phase 0** | ✅ Complete | 3/3 | Shell injection fixed, DB indexed, worktree mutex |
| **Phase 1** | ✅ Complete (1.2 deferred) | 2/3 | 8 agent tools, adaptive loop heuristics |
| **Phase 2** | ✅ Complete | 3/3 | Fuzzy matching, line-range edits, atomic rollback |
| **Phase 3** | ✅ Complete | 4/4 | Cherry-pick resolution, task queue, checkpoint/resume, isolated deps |
| **Phase 4** | ✅ Complete | 3/3 | Model router, provider abstraction, token budgets |
| **Phase 5** | ✅ Complete | 3/3 | Configurable runtime gates, new gate types, parallel execution |
| **Phase 6** | ✅ Complete | 3/3 | Telemetry, cost dashboard, learning loop |
| **Phase 7** | ✅ Complete | 3/3 | Discord UX, console upgrades, webhooks |
| **Phase 8** | ✅ Complete | 3/3 | Multi-agent, multi-repo, knowledge graph |

---

## Effort vs Impact Matrix

```
                        HIGH IMPACT
                            |
     Phase 0: Fixes --------+-------- Phase 1: Agent Tools
     ✅ DONE                |         ✅ DONE
                            |
                            |
     Phase 5: Gates --------+-------- Phase 2: Edit Reliability
     ✅ DONE                |         ✅ DONE
                            |
  LOW EFFORT ───────────────+─────────────── HIGH EFFORT
                            |
     Phase 4: Multi-Model --+-------- Phase 3: Orchestration
     ✅ DONE                |         ✅ DONE
                            |
                            |
     Phase 6: Telemetry ----+-------- Phase 7: UX
     ✅ DONE                |         ✅ DONE
                            |
                        LOW IMPACT
                     (but compounds)
```

**All phases complete.** The evolution plan is fully implemented.

---

## Execution Principle

> Ship each phase as a working increment. Don't build Phase 8 abstractions in Phase 1.
> The right time to add multi-repo support is when you actually need a second repo, not before.
> Measure before optimizing. Add telemetry early (Phase 6) so you know which improvements actually move the needle.
