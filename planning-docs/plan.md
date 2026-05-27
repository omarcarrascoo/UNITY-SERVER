                                                                                                   
     Evolution Plan — Iteration Analysis                                                                                                                                                                            
                                                                                                                      
     Iteration Overview: Full Evolution Plan (Phases 0-8)                                                                                                                                                           
                                                                                                                                                                                                                
     Scale: 2,678 lines added, 591 removed across 24 files. 13 new files created.                                                                                                                                   
      This is a massive leap from POC to production-grade autonomous dev
     orchestrator.

     ---
     What's Included — Phase by Phase

     Phase 0: Critical Fixes (Foundation)

     - Shell injection fix in git.ts — execPromise → execFilePromise with
     array args
     - 10 database indexes on hot query paths in unity-store.ts
     - Worktree mutex — async FIFO lock prevents race conditions in create/remove

     Phase 1: Agent Intelligence

     - 5 new tools: grep_code, list_directory, find_references,
     run_tests, write_file (in tools.ts — 743 lines of changes)
     - Adaptive loop heuristics (loop-heuristics.ts): Spiral detection (3-cycle
      repeat), information gain tracking (high/low/stale), progressive iteration
     pressure (nudge at 15, firm at 25, hard at 100). Removed all hardcoded
     project-specific keywords.

     Phase 2: Edit Reliability

     - Line-range editing — startLine/endLine field-based splicing
     - Fuzzy matching fallback — 85% similarity threshold with whitespace
     normalization
     - Atomic edit transactions — snapshot before, rollback all on any failure

     Phase 3: Orchestration Robustness

     - Cherry-pick conflict auto-resolution — accepts "theirs" strategy, aborts
     cleanly on failure
     - TaskQueue (task-queue.ts): Priority levels (critical/normal/low),
     configurable concurrency (default 6), per-task timeout via AbortController,
     project-level cancellation, graceful drain
     - Checkpoint/Resume — detects crash-interrupted runs, resets running →
     pending, logs progress
     - Isolated node_modules — detects dependency-modifying tasks and runs npm install instead of symlinking

     Phase 4: Multi-Model Strategy

     - Model Router (model-router.ts): 7 roles mapped to deepseek-v4-pro —
     code-gen/pr-metadata/architect enable thinking mode with reasoning_effort,
     planning/review/repair/explorer run in chat mode (thinking disabled)
     - Provider Abstraction (completion.ts + providers/): Normalized
     request/response types, fallback registry, single roleCompletion() entry point
     - Token Budget Tracking (token-tracker.ts): 2M per run, 500K per task,
     warning at 75%, hard stop at 100%

     Phase 5: Gate System Evolution

     - Configurable runtime gates (runtime-gate-config.ts): Auto-detection for
     Expo/NestJS/Next.js/Vite + manual .unity/gates.json
     - New gate types: Security scan (hardcoded secrets detection) + Import cycle
      detection (DFS on dependency graph)
     - Parallel gate execution: All gates run concurrently with per-gate timeouts
      (typecheck 90s, lint 60s, test 180s, build 120s)

     Phase 6: Observability & Learning (detailed below)

     Phase 7: Transport & UX

     - Discord: Policy presets (/policy preset:conservative|balanced|aggressive), /cost command, /learning command,
      elapsed time in progress messages
     - HTTP Console: Diff viewer, re-run failed tasks button, task timeline API
     - Webhooks (webhooks/): GitHub webhook with HMAC-SHA256 verification,
     /unity run comment triggers, push-to-branch triggers

     Phase 8: Advanced Architecture

     - Multi-Agent Pipeline: Explorer (read-only, chat tier) → Architect (no
     tools, reasoning tier) → Implementer (write tools, reasoning tier). Non-blocking
      — pipeline failures degrade gracefully.
     - Multi-Repo Orchestration (multi-repo.ts): Topological sort for
     cross-repo dependencies, coordinated PR generation
     - Knowledge Graph (knowledge/): SQLite-backed module tracking, hot file
     detection, fragility scoring (failureFrequency / changeFrequency), API surface
      tracking, architecture decision records

     ---
     Deep Analysis: The Autolearning Module

     Architecture

     The learning system is a closed-loop feedback system with 4 components
     across src/services/learning/:

     1. LearningStore (learning-store.ts) — SQLite persistence with patterns
     - pattern_outcomes tables
     2. PatternExtractor (pattern-extractor.ts) — Captures what worked after
     successful tasks
     3. PromptInjector (prompt-injector.ts) — Retrieves relevant patterns and
     injects into future prompts
     4. Index (index.ts) — Public API

     Data Flow

     Task Succeeds → extractPattern() → LearnedPattern saved to DB
                                               ↓
     New Task Arrives → buildLearningContext() → Queries DB → Scores relevance
                                               ↓
                       formatPatternsAsGuidance() → Injected into system prompt
                                               ↓
                       Task Executes (with pattern guidance)
                                               ↓
                       recordPatternOutcomes() → Updates effectiveness scores
                                               ↓
                       10% chance → prune + deduplicate

     What a Pattern Captures

     Each LearnedPattern stores: project name, task kind, file scope pattern,
     keyword tags, LLM-generated approach summary (2-3 sentences), iteration
     count, token usage, files read/edited, top 5 tools used, and effectiveness
     metrics.

     Relevance Scoring (Multi-Factor)

     ┌─────────────────────┬────────┬─────────────────────────────────────────────┐
     │       Factor        │ Weight │                    Logic                    │
     ├─────────────────────┼────────┼─────────────────────────────────────────────┤
     │ Project match       │ 30%    │ Exact project name match                    │
     ├─────────────────────┼────────┼─────────────────────────────────────────────┤
     │ Task kind match     │ 20%    │ Same kind (implement/fix/refactor/etc.)     │
     ├─────────────────────┼────────┼─────────────────────────────────────────────┤
     │ File scope overlap  │ 25%    │ Glob prefix matching on write scope         │
     ├─────────────────────┼────────┼─────────────────────────────────────────────┤
     │ Keyword overlap     │ 25%    │ Exact + partial tag matching                │
     ├─────────────────────┼────────┼─────────────────────────────────────────────┤
     │ Effectiveness bonus │ 10%    │ Only if applied 2+ times, weighted by score │
     └─────────────────────┴────────┴─────────────────────────────────────────────┘

     Candidates are filtered: effectiveness_score >= -0.3 AND (same project OR
     effectiveness_score > 0.7 for cross-project). Top 3 returned.

     Self-Improvement Mechanics

     - Effectiveness score: (successes - failures) / applications — range [-1,
     1]
     - Pruning: Patterns with score < -0.5 after 3+ applications are deleted
     - Deduplication: Groups by (project, kind, file_pattern), keeps
     highest-scoring
     - Both triggered probabilistically (~10% of outcome recordings)

     Current Gaps in the Learning Module

     1. filesRead is always [] — the extraction at line ~630 in
     run-autonomous-agent.ts passes empty array. Tool read history from agent
     execution is never captured.
     2. toolHistory is always [] — same issue, so topTools extraction is
     empty. This degrades pattern quality.
     3. iterations passed as 0 — actual iteration count not threaded through
     from agent-runner.
     4. No temporal decay — old patterns never lose relevance purely by age, only
      by poor effectiveness.

     ---
     Deep Analysis: Panel Data Gap (What's Collected vs. What's Shown)

     This is the most significant finding. There's a massive gap between data
     being collected and what users can see.

     Currently Exposed in Panel

     ┌──────────────────────────┬─────────────────────────────────────────────────────────┐
     │         Endpoint         │                          Data                           │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/runs, /api/runs/:id │ Run list, detail with tasks/events/artifacts            │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/runs/:id/cost       │ Aggregate cost summary                                  │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/runs/:id/diff       │ Git diff                                                │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/runs/:id/timeline   │ Task execution timeline                                 │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/telemetry/stats     │ Project-level totals                                    │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/learning/patterns   │ Top patterns                                            │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/learning/stats      │ Learning stats                                          │
     ├──────────────────────────┼─────────────────────────────────────────────────────────┤
     │ /api/knowledge/*         │ Knowledge snapshot, hot files, fragile areas, decisions │
     └──────────────────────────┴─────────────────────────────────────────────────────────┘

     Data Collected but 100% Hidden from Users

     ┌──────────────────────────────────────────────┬─────────────────────────────────────────────────────────────┬─────────────────────┐
     │                 Hidden Data                  │                       Where Collected                       │   Why It Matters    │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Individual telemetry events                  │ telemetry-store.ts — listEventsByRun()                      │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ exists, no HTTP endpoint                     │ Users can't see per-LLM-call token usage, individual        │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ gate results, or edit success/failure events │                                                             │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Gate-level pass/fail tracking                │ telemetry/index.ts — gate.{name}                            │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ events recorded                              │ Users can't see which specific gates are failing most often │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Edit metrics                                 │ edit.applied / edit.failed events with fuzzy match          │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ counts, error messages                       │ Users can't see if edits are reliable or if fuzzy           │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ matching is saving them                      │                                                             │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Task iteration counts                        │ Stored in event metadata                                    │ Users can't see how │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ many iterations each task took               │                                                             │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Per-model token breakdown per task           │ Recorded but only run-level                                 │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ aggregates exposed                           │ Users can't optimize cost per task type                     │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Duration metrics                             │ durationMs on every telemetry event                         │ No performance      │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ trends visible                               │                                                             │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Module dependency graph                      │ knowledge-graph.ts — dependencies[],                        │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ dependents[], exports[]                      │ Users can't visualize the dependency graph                  │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ File change history with gate results        │ file_change_log table with                                  │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ gatePassed flag                              │ Users can't see which changes broke gates                   │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Change attribution                           │ taskId linked to file changes                               │ Users can't trace   │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ which task changed which file                │                                                             │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ API endpoint consumers                       │ consumers[] array in api_endpoints table                    │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Relationship data never queried              │                                                             │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Module type distribution                     │ 8 module types categorized                                  │ Never queried       │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Run constraints                              │ maxParallelTasks, maxRetries, maxHours,                     │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ maxCommits                                   │ Not exposed                                                 │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Memory entries                               │ upsertMemory() in unity-store                               │ No HTTP endpoint    │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Policies                                     │ upsertPolicy() / getPolicy()                                │ No HTTP endpoint    │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Night jobs                                   │ createNightJob()                                            │ No HTTP endpoint    │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Resumable runs                               │ listResumableRuns()                                         │ Not exposed         │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Plan version history                         │ version field in plans table                                │ Only latest         │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ returned                                     │                                                             │                     │
     ├──────────────────────────────────────────────┼─────────────────────────────────────────────────────────────┼─────────────────────┤
     │ Task hierarchy                               │ parentTaskId relationships                                  │ Not queryable       │
     └──────────────────────────────────────────────┴─────────────────────────────────────────────────────────────┴─────────────────────┘

     Summary: ~90% of telemetry data and ~70% of knowledge graph data is

     invisible to users.

     The system is collecting incredibly rich observability data (individual LLM call
      costs, gate results, edit reliability metrics, module fragility trends, file
     change attribution) but the panel only shows high-level aggregates. The
     infrastructure for a world-class dashboard is already in the database — it just
     needs endpoints and UI.

     ---
     Deep Analysis: Run run_9154675559b04b00 — Complete 3-Hour Autonomous Run

     Run Overview

     ┌───────────────────────────────────┬─────────────────────────────────────────────────────────┐
     │              Metric               │                          Value                          │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Run ID                            │ run_9154675559b04b00                                    │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Project                           │ mono-repo-kubo                                          │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Duration                          │ ~3 hours (12:34 PM → ~3:34 PM)                          │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Final Status                      │ failed                                                  │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Tasks                             │ 10 total: 8 succeeded, 2 blocked                        │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Commits Used                      │ 8 of 20 budget                                          │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Critical Failure                  │ "Update header menu navigation in _layout and tabs" — 4 │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ attempts, never completed         │                                                         │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ Baseline Gates                    │ 3 pre-existing failures: lint:infra-red,                │
     ├───────────────────────────────────┼─────────────────────────────────────────────────────────┤
     │ tsc:kubo-mobile, lint:kubo-mobile │                                                         │
     └───────────────────────────────────┴─────────────────────────────────────────────────────────┘

     Timeline

     12:34  Run started
     12:34  Checkpoint resume detected — crash-interrupted runs reset running→pending
     12:39  Plan approved (10 tasks generated)
     12:39  8 independent tasks start executing
     ~13:00 First wave of tasks completing (Help screen, Settings, etc.)
     ~13:30 5/8 dependency tasks for "Update header menu" complete
     ~14:00 "Update header menu" task begins (attempt 1)
     ~14:30 Attempt 1 fails — reviewer rejects (redirect spiral, no meaningful edits)
     ~14:45 Attempt 2 fails — empty edits, fails validation
     ~15:00 Attempt 3 — reviewer approves! Cherry-pick succeeds... SSL TIMEOUT on
     push
     ~15:15 Attempt 4 — reviewer rejects (introduced TypeScript errors)
     ~15:24 3-hour max window reached → graceful drain → run marked failed

     ---
     Per-Task Performance Breakdown

     Successful Tasks (8/10)

     ┌──────────────────────────────────────────────────────────────────────────────────┬────────────┬───────────────┬────────────────────┐
     │                                       Task                                       │ Iterations │    Outcome    │       Notes        │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Help screen content                                                              │ ~37        │ Succeeded     │ First attempt had  │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ write_file→search/replace collision. Fuzzy matching couldn't recover (whole file │            │               │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ replaced). Eventually succeeded after high iteration count.                      │            │               │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Settings notifications toggle                                                    │ Low        │ Clean success │ Straightforward UI │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ toggle                                                                           │            │               │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Profile avatar upload                                                            │ Low        │ Clean success │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Onboarding flow screens                                                          │ Low        │ Clean success │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Search functionality                                                             │ Low        │ Clean success │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Dark mode toggle                                                                 │ Low        │ Clean success │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Push notification service                                                        │ Low        │ Clean success │                    │
     ├──────────────────────────────────────────────────────────────────────────────────┼────────────┼───────────────┼────────────────────┤
     │ Localization i18n setup                                                          │ Low        │ Clean success │                    │
     └──────────────────────────────────────────────────────────────────────────────────┴────────────┴───────────────┴────────────────────┘

     Key observation: 7 of 8 succeeded cleanly with low iteration counts. The
     Help screen task burned ~37 iterations due to the write_file/search_replace
     collision pattern (detailed below). Overall task success rate for independent
     tasks: 100%.

     Failed Task: "Update header menu navigation in _layout and tabs"

     This is the only task that failed and it caused the entire run to fail. It
     had 5 dependencies (waited for 5 other tasks to complete before starting),
     making it the final bottleneck.

     ---
     Root Cause Analysis: The Header Menu Navigation Failure

     Why This Task Was Uniquely Hard

     1. 5 dependencies — By the time it started, 5 other tasks had already
     modified the codebase. The files it needed to edit (_layout.tsx, tab configs)
     had been touched by prior tasks.
     2. Late start — Began ~2 hours into a 3-hour window, leaving only ~1 hour
     for 4 attempts.
     3. Cross-cutting concern — Navigation/layout changes touch multiple files
     that other features also modify.

     Attempt 1: The Redirect Spiral

     What happened: The agent entered an exploration loop, reading files and
     grepping for patterns. Loop heuristics detected a spiral (3-cycle repeat of the
     same tool calls) and issued a redirect: "Stop exploring and produce the
     implementation based on what you already know."

     The problem: The agent received the redirect but instead of producing
     implementation JSON, it continued exploring with slightly different queries.
      This triggered MORE redirects. The logs show consecutive "redirected to
     implementation" messages with no productive work between them.

     Code path: agent-runner.ts lines 86-107 — when redirect triggers, all
     pending tool calls get [Skipped — redirecting to implementation]. The agent
     sees this but treats it as information rather than a hard stop.

     Root cause: The redirect message is advisory, not enforced. The agent can
     simply issue new tool calls in the next iteration. The progressive pressure at
     iteration 25 ("hard limit warning") eventually forces output, but by then the
     agent has burned 25+ iterations exploring.

     Fix needed: After N consecutive redirects (e.g., 3), force the agent to
     produce output by refusing to execute ANY tool calls and only accepting JSON
     responses.

     Attempt 2: Empty Edits

     What happened: The agent produced an edit response, but the edits: []
     array was empty or contained only trivial comment changes. The reviewer or
     validation caught this and rejected it.

     Code path: edit-operations.ts — when edit.search.trim() === '', the
     system does a full file overwrite (line 237). If the agent submits an empty
     search block accidentally, it replaces the entire file.

     Root cause: The agent's Architect phase produced a vague plan (possibly
     because Explorer returned 0 entry points). Without concrete file change
     instructions, the Implementer generated empty or trivial edits.

     Evidence from logs: Explorer reaching iteration limit returns entryPoints: [] fallback (agent-roles.ts line 283-293). The Architect then works with zero
      context about which files to change, producing a generic plan. The Implementer,
      seeing "Proceed with direct implementation" with no file targets, generates
     nothing meaningful.

     Fix needed: If Explorer returns 0 entry points, inject the task's dependency
      chain's modified files as seed context. The 5 completed dependency tasks
     already touched the relevant files — their commit diffs should inform the
     Explorer.

     Attempt 3: Success... Then SSL Timeout

     What happened: This was the golden attempt. The agent:
     1. Explorer found entry points (likely because prior attempt context helped)
     2. Architect produced a concrete plan
     3. Implementer generated valid edits
     4. Gates passed (or matched baseline failures)
     5. Reviewer approved
     6. Cherry-pick onto integration branch succeeded

     Then git push origin <branch> timed out with an SSL connection error.

     Code path: branch-manager.ts line 236-238 — raw git push with no retry
      logic, no timeout wrapper, no error recovery.

     Impact: A 3-hour run's critical task was lost because of a transient network
      failure. The entire attempt was wasted and the task went back to pending for
     attempt 4.

     Fix needed:
     - Add retry logic for push operations (3 retries with exponential backoff)
     - Set explicit timeout (30s) with retry on timeout
     - If push succeeds on retry, don't waste another full agent execution

     Attempt 4: TypeScript Errors in Review

     What happened: The agent tried again but this time introduced TypeScript
     errors. The reviewer caught them and rejected.

     Root cause: The agent was working against a codebase that had been modified
     by attempt 3's cherry-pick (which succeeded locally even though push failed).
     The worktree state was inconsistent — attempt 3's changes were partially
     applied.

     Additionally: The baseline already had tsc:kubo-mobile failing. The
     reviewer prompt says "DO NOT reject if a normal gate fails if that SAME gate was
      already failing in baseline." But the agent introduced NEW TypeScript errors on
      top of the existing ones. The baseline-delta gate caught this correctly.

     Fix needed: After a push failure, the cherry-picked commit should be
     reverted from the integration branch to restore clean state for the next
     attempt.

     ---
     Systemic Issues Identified

     1. Redirect Spiral Ineffectiveness

     Problem: The redirect mechanism in loop heuristics detects spirals correctly
      but can't enforce them. An agent that ignores the redirect just burns more
     iterations.

     Evidence: Multiple consecutive "redirected to implementation" log entries
     with the agent continuing to explore.

     Current code: loop-heuristics.ts sets shouldRedirect: true and returns a
      reason string. agent-runner.ts responds to all tool calls with "Skipped" and
     adds a user message. But the agent can issue NEW tool calls in the very next
     iteration.

     Recommendation:
     - Track consecutive redirect count in agent-runner.ts
     - After 3 consecutive redirects: strip all tools from the next LLM call, forcing
      pure text/JSON output
     - After 5 consecutive redirects: inject a hard schema constraint requiring
     AIResponse JSON format

     2. Explorer Producing 0 Entry Points

     Problem: Explorer has a 30-iteration limit (agent-roles.ts line 225). When
      it hits this limit without finding relevant files, it returns entryPoints: []. The Architect then has no context.

     Evidence: The "Update header menu" task's Architect produced empty/vague
     plans.

     Why it happens: In a large monorepo, the Explorer may spend all 30
     iterations navigating directory structure without finding the right files,
     especially when the task description is vague ("Update header menu navigation in
      _layout and tabs").

     Recommendation:
     - Feed dependency task outputs (files modified, commit messages) as seed context
      to Explorer
     - Increase Explorer iteration limit for tasks with 3+ dependencies (they're
     inherently more complex)
     - If Explorer returns 0 entry points, run a targeted file search using task
     title keywords before falling back

     3. Edit Mechanism Failure After Prior Task Modifications

     Problem: When Task A modifies _layout.tsx and Task B later tries to edit
     the same file, Task B's agent may have read an OLD version of the file. The
     search block won't match the current content.

     Evidence: Help screen task's write_file→search/replace collision. The agent
     used write_file to create the file, then tried search/replace against the
     original content. The file had been completely replaced, so the search block
     didn't match, and fuzzy matching couldn't recover (similarity < 0.85 because the
      entire file changed).

     Current mitigation: edit-operations.ts line 277 tells the agent to
     read_file before patching. But this is a prompt instruction, not enforced.

     Recommendation:
     - Before applying any search/replace edit, automatically re-read the file and
     validate the search block exists
     - If search block doesn't match, return the CURRENT file content to the agent
     (not just an error message)
     - For tasks with dependencies, inject a "files modified by prior tasks" list so
     the agent knows which files need fresh reads

     4. SSL/Network Timeout Has No Resilience

     Problem: A single SSL timeout on git push kills the entire task attempt.
     No retry, no backoff, no recovery.

     Code: branch-manager.ts — raw execFilePromise('git', ['push', ...]) with
      no error handling for transient failures.

     Impact: Attempt 3 of the critical task was the ONLY successful
     implementation across 4 attempts. It was lost to a network blip.

     Recommendation:
     - Wrap all git remote operations (push, fetch, pull) in a retry helper
     - 3 retries, exponential backoff (1s, 3s, 9s)
     - Distinguish transient errors (SSL timeout, connection reset) from permanent
     errors (auth failure, rejected push)
     - Log retry attempts for observability

     5. Pre-existing Gate Failures Confusing the Agent

     Problem: Baseline has 3 failing gates (lint:infra-red, tsc:kubo-mobile,
     lint:kubo-mobile). The reviewer correctly handles this via baseline-delta
     comparison. But the AGENT sees these errors during its own run_tests or
     compilation checks and tries to fix them, wasting iterations.

     Evidence: Agent spending iterations trying to fix TypeScript errors that
     pre-existed in the monorepo.

     Recommendation:
     - Inject baseline failure summary into the agent's system prompt: "The following
      gates are ALREADY FAILING in baseline. Do NOT attempt to fix them: [list]"
     - Filter baseline-matching errors from the agent's compilation check output
     - The Execution Contract prompt (planner.ts line 35-45) already says "do not
     chase unrelated repo errors" but it needs to be more specific with actual error
     signatures

     6. Task Budget vs. Time Budget Mismatch

     Problem: Run had budget for 20 commits but only 3 hours. The header
     navigation task used 4 attempts × ~50 iterations each = ~200 iterations on ONE
     task. Meanwhile, 8/20 commits were used on easy tasks.

     Recommendation:
     - Implement per-task time budgets, not just iteration limits
     - For the final task in a dependency chain, allocate proportionally more time
     - When a task has failed 2+ times and is the last blocker, consider reducing
     scope (split into smaller sub-tasks)

     ---
     Performance Metrics Summary

     ┌───────────────────────────────┬─────────────────────────┬────────────────────────────────┐
     │            Metric             │          Value          │           Assessment           │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Independent task success rate │ 8/8 (100%)              │ Excellent                      │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Dependent task success rate   │ 0/1 (0%)                │ Critical failure               │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Overall task completion       │ 8/10 (80%)              │ 2 blocked by failed dependency │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Commits used / budget         │ 8/20 (40%)              │ Under-utilized                 │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Time utilization              │ 3h/3h (100%)            │ Hit max window                 │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Iterations on failed task     │ ~200+ across 4 attempts │ Severe waste                   │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Checkpoint resume             │ Worked correctly        │ Good                           │
     ├───────────────────────────────┼─────────────────────────┼────────────────────────────────┤
     │ Baseline handling             │ Correctly identified    │ Good                           │
     └───────────────────────────────┴─────────────────────────┴────────────────────────────────┘

     ---
     Priority Fixes (Ordered by Impact)

     P0 — Ship Blockers

     1. Git push retry logic — A transient network error should never waste a
     successful 50-iteration agent run. 3 retries with exponential backoff.
     (branch-manager.ts)
     2. Hard redirect enforcement — After 3 consecutive redirects, strip tools
     from LLM call. Agent MUST produce JSON. (agent-runner.ts)

     P1 — High Impact

     3. Dependency context injection — Feed completed dependency tasks' file
     changes into Explorer/Architect prompts. This is the single biggest quality
     improvement for dependent tasks.
     4. Baseline error filtering — Inject baseline failure signatures into agent
     prompt to prevent wasted iterations fixing pre-existing issues.
     5. Post-push-failure state cleanup — After cherry-pick succeeds but push
     fails, revert the cherry-pick to restore clean integration branch state.

     P2 — Medium Impact

     6. Pre-edit file validation — Before applying search/replace, auto-verify
     search block against current file content. Return current content on mismatch.
     7. Explorer fallback enhancement — When Explorer returns 0 entry points, run
      keyword-based file search using task title before giving up.
     8. Per-task time budgets — Prevent one task from consuming the entire run
     window.

     P3 — Quality of Life

     9. Learning module data gaps — Wire through filesRead, toolHistory, and
     iterations to pattern extraction. Currently all [] and 0.
     10. Consecutive redirect metrics — Track and expose redirect spiral
     frequency in telemetry for monitoring.

     ---
     What Worked Well

     1. Checkpoint/Resume — Detected crash-interrupted run and recovered
     correctly
     2. Parallel task execution — 8 independent tasks ran concurrently and all
     succeeded
     3. Baseline-delta gate logic — Correctly distinguished pre-existing failures
      from new regressions
     4. Edit atomicity — Rollback on failure prevented corrupted files
     5. Cherry-pick conflict resolution — "theirs" strategy worked for
     non-conflicting integrations
     6. Progressive iteration pressure — Prevented infinite loops (though
     redirect enforcement needs strengthening)
     7. Learning pattern extraction — Extracted patterns from 8 successful tasks
     for future runs
     8. Fuzzy edit matching — Saved several edits where whitespace had shifted

     "/plan open" to edit this plan in VS Code