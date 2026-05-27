# Evolution Plan — Iteration Analysis

## Iteration Overview: Full Evolution Plan (Phases 0-8)

**Scale**: 2,678 lines added, 591 removed across 24 files. 13 new files created. This is a massive leap from POC to production-grade autonomous dev orchestrator.

---

## What's Included — Phase by Phase

### Phase 0: Critical Fixes (Foundation)
- **Shell injection fix** in `git.ts` — `execPromise` → `execFilePromise` with array args
- **10 database indexes** on hot query paths in `unity-store.ts`
- **Worktree mutex** — async FIFO lock prevents race conditions in create/remove

### Phase 1: Agent Intelligence
- **5 new tools**: `grep_code`, `list_directory`, `find_references`, `run_tests`, `write_file` (in `tools.ts` — 743 lines of changes)
- **Adaptive loop heuristics** (`loop-heuristics.ts`): Spiral detection (3-cycle repeat), information gain tracking (high/low/stale), progressive iteration pressure (nudge at 15, firm at 25, hard at 100). Removed all hardcoded project-specific keywords.

### Phase 2: Edit Reliability
- **Line-range editing** — `startLine`/`endLine` field-based splicing
- **Fuzzy matching fallback** — 85% similarity threshold with whitespace normalization
- **Atomic edit transactions** — snapshot before, rollback all on any failure

### Phase 3: Orchestration Robustness
- **Cherry-pick conflict auto-resolution** — accepts "theirs" strategy, aborts cleanly on failure
- **TaskQueue** (`task-queue.ts`): Priority levels (critical/normal/low), configurable concurrency (default 6), per-task timeout via AbortController, project-level cancellation, graceful drain
- **Checkpoint/Resume** — detects crash-interrupted runs, resets `running` → `pending`, logs progress
- **Isolated node_modules** — detects dependency-modifying tasks and runs `npm install` instead of symlinking

### Phase 4: Multi-Model Strategy
- **Model Router** (`model-router.ts`): 7 roles mapped to `deepseek-v4-pro` — code-gen/pr-metadata/architect enable thinking mode with `reasoning_effort`, planning/review/repair/explorer run in chat mode (thinking disabled)
- **Provider Abstraction** (`completion.ts` + `providers/`): Normalized request/response types, fallback registry, single `roleCompletion()` entry point
- **Token Budget Tracking** (`token-tracker.ts`): 2M per run, 500K per task, warning at 75%, hard stop at 100%

### Phase 5: Gate System Evolution
- **Configurable runtime gates** (`runtime-gate-config.ts`): Auto-detection for Expo/NestJS/Next.js/Vite + manual `.unity/gates.json`
- **New gate types**: Security scan (hardcoded secrets detection) + Import cycle detection (DFS on dependency graph)
- **Parallel gate execution**: All gates run concurrently with per-gate timeouts (typecheck 90s, lint 60s, test 180s, build 120s)

### Phase 6: Observability & Learning (detailed below)

### Phase 7: Transport & UX
- **Discord**: Policy presets (`/policy preset:conservative|balanced|aggressive`), `/cost` command, `/learning` command, elapsed time in progress messages
- **HTTP Console**: Diff viewer, re-run failed tasks button, task timeline API
- **Webhooks** (`webhooks/`): GitHub webhook with HMAC-SHA256 verification, `/unity run` comment triggers, push-to-branch triggers

### Phase 8: Advanced Architecture
- **Multi-Agent Pipeline**: Explorer (read-only, chat tier) → Architect (no tools, reasoning tier) → Implementer (write tools, reasoning tier). Non-blocking — pipeline failures degrade gracefully.
- **Multi-Repo Orchestration** (`multi-repo.ts`): Topological sort for cross-repo dependencies, coordinated PR generation
- **Knowledge Graph** (`knowledge/`): SQLite-backed module tracking, hot file detection, fragility scoring (`failureFrequency / changeFrequency`), API surface tracking, architecture decision records

---

## Deep Analysis: The Autolearning Module

### Architecture
The learning system is a **closed-loop feedback system** with 4 components across `src/services/learning/`:

1. **LearningStore** (`learning-store.ts`) — SQLite persistence with `patterns` + `pattern_outcomes` tables
2. **PatternExtractor** (`pattern-extractor.ts`) — Captures what worked after successful tasks
3. **PromptInjector** (`prompt-injector.ts`) — Retrieves relevant patterns and injects into future prompts
4. **Index** (`index.ts`) — Public API

### Data Flow

```
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
```

### What a Pattern Captures
Each `LearnedPattern` stores: project name, task kind, file scope pattern, keyword tags, **LLM-generated approach summary** (2-3 sentences), iteration count, token usage, files read/edited, top 5 tools used, and effectiveness metrics.

### Relevance Scoring (Multi-Factor)
| Factor | Weight | Logic |
|--------|--------|-------|
| Project match | 30% | Exact project name match |
| Task kind match | 20% | Same kind (implement/fix/refactor/etc.) |
| File scope overlap | 25% | Glob prefix matching on write scope |
| Keyword overlap | 25% | Exact + partial tag matching |
| Effectiveness bonus | 10% | Only if applied 2+ times, weighted by score |

Candidates are filtered: `effectiveness_score >= -0.3` AND (same project OR `effectiveness_score > 0.7` for cross-project). Top 3 returned.

### Self-Improvement Mechanics
- **Effectiveness score**: `(successes - failures) / applications` — range [-1, 1]
- **Pruning**: Patterns with score < -0.5 after 3+ applications are deleted
- **Deduplication**: Groups by (project, kind, file_pattern), keeps highest-scoring
- Both triggered probabilistically (~10% of outcome recordings)

### Current Gaps in the Learning Module
1. **`filesRead` is always `[]`** — the extraction at line ~630 in `run-autonomous-agent.ts` passes empty array. Tool read history from agent execution is never captured.
2. **`toolHistory` is always `[]`** — same issue, so `topTools` extraction is empty. This degrades pattern quality.
3. **`iterations` passed as `0`** — actual iteration count not threaded through from agent-runner.
4. **No temporal decay** — old patterns never lose relevance purely by age, only by poor effectiveness.

---

## Deep Analysis: Panel Data Gap (What's Collected vs. What's Shown)

This is the most significant finding. There's a **massive gap** between data being collected and what users can see.

### Currently Exposed in Panel
| Endpoint | Data |
|----------|------|
| `/api/runs`, `/api/runs/:id` | Run list, detail with tasks/events/artifacts |
| `/api/runs/:id/cost` | Aggregate cost summary |
| `/api/runs/:id/diff` | Git diff |
| `/api/runs/:id/timeline` | Task execution timeline |
| `/api/telemetry/stats` | Project-level totals |
| `/api/learning/patterns` | Top patterns |
| `/api/learning/stats` | Learning stats |
| `/api/knowledge/*` | Knowledge snapshot, hot files, fragile areas, decisions |

### Data Collected but **100% Hidden** from Users

| Hidden Data | Where Collected | Why It Matters |
|-------------|----------------|----------------|
| **Individual telemetry events** | `telemetry-store.ts` — `listEventsByRun()` exists, no HTTP endpoint | Users can't see per-LLM-call token usage, individual gate results, or edit success/failure events |
| **Gate-level pass/fail tracking** | `telemetry/index.ts` — `gate.{name}` events recorded | Users can't see which specific gates are failing most often |
| **Edit metrics** | `edit.applied` / `edit.failed` events with fuzzy match counts, error messages | Users can't see if edits are reliable or if fuzzy matching is saving them |
| **Task iteration counts** | Stored in event metadata | Users can't see how many iterations each task took |
| **Per-model token breakdown per task** | Recorded but only run-level aggregates exposed | Users can't optimize cost per task type |
| **Duration metrics** | `durationMs` on every telemetry event | No performance trends visible |
| **Module dependency graph** | `knowledge-graph.ts` — `dependencies[]`, `dependents[]`, `exports[]` | Users can't visualize the dependency graph |
| **File change history with gate results** | `file_change_log` table with `gatePassed` flag | Users can't see which changes broke gates |
| **Change attribution** | `taskId` linked to file changes | Users can't trace which task changed which file |
| **API endpoint consumers** | `consumers[]` array in `api_endpoints` table | Relationship data never queried |
| **Module type distribution** | 8 module types categorized | Never queried |
| **Run constraints** | `maxParallelTasks`, `maxRetries`, `maxHours`, `maxCommits` | Not exposed |
| **Memory entries** | `upsertMemory()` in unity-store | No HTTP endpoint |
| **Policies** | `upsertPolicy()` / `getPolicy()` | No HTTP endpoint |
| **Night jobs** | `createNightJob()` | No HTTP endpoint |
| **Resumable runs** | `listResumableRuns()` | Not exposed |
| **Plan version history** | `version` field in plans table | Only latest returned |
| **Task hierarchy** | `parentTaskId` relationships | Not queryable |

### Summary: ~90% of telemetry data and ~70% of knowledge graph data is invisible to users.

The system is collecting incredibly rich observability data (individual LLM call costs, gate results, edit reliability metrics, module fragility trends, file change attribution) but the panel only shows high-level aggregates. The infrastructure for a world-class dashboard is already in the database — it just needs endpoints and UI.
