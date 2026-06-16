# Runtime Reliability + FE/BE Auto-Healing — Design

> **Goal**: make the autonomous runs reliably (1) install deps so FE+BE actually boot, and
> (2) auto-heal runtime startup failures instead of just reporting them as warnings.
>
> **Status**: IMPLEMENTED across several iterations. Most pieces verified individually;
> the full FE heal cycle is NOT yet verified end-to-end in a single run. See
> **§16 Implementation Status & Open Items** at the bottom — that's the checklist to
> finish later.
> **Touches**: the core orchestrator (`run-autonomous-agent.ts`) + runtime gate files.

---

## 0. Problem statement (verified against current code)

Three real issues, confirmed by reading the code:

1. **FE almost never passes the runtime gate.** `runtime-gate-config.ts:180` waits for the literal
   string `'ready in'` from `npx expo start --web`, with `DEFAULT_TIMEOUT_MS = 30_000` (30s). A real
   Expo project's Metro bundle routinely takes **longer than 30s**, and modern Expo doesn't always emit
   exactly `'ready in'`. → false "exited before ready" failures.

2. **Base workspace deps can be stale for the runtime gate.** `prepareWorkspace` (`git.ts:165`) runs
   `npm install` per package at prep time. But task worktrees **symlink** `node_modules` from the base
   (`worktree-manager.ts:170`). The runtime gate runs on `baseWorkspace` (`run-autonomous-agent.ts:1406`).
   If a task added a dependency to `package.json`, the base `node_modules` never gets the new package —
   and `ensureNodeModules` only reinstalls when `node_modules` is **entirely missing**, not when one dep
   is absent. → "Unable to resolve X" at boot.

3. **No runtime auto-healing.** The runtime gate runs ONCE, *after* the task loop closes
   (`run-autonomous-agent.ts:1406`, outside the `while`). Its result only feeds the summary
   (→ `completed_with_warnings`). A failed boot **never reopens tasks to fix it**. The
   `improvementCycle`/`healing` machinery exists but is only fed by reviewer `followUpTasks`, never by
   runtime failures.

---

## 1. Design principles

1. **Reuse the existing healing machinery.** `createImprovementTasks()` + the `healing` run status +
   `improvementCycle < maxImprovementCycles` loop already exist (`run-autonomous-agent.ts:1148-1173`).
   Runtime healing should **feed tasks into that same mechanism**, not build a parallel one.
2. **Move the runtime gate INSIDE the loop boundary** (or make it loop-aware) so a failure can spawn a
   repair task and re-run, bounded by `maxImprovementCycles` and the time/commit budget.
3. **Parse the failure into an actionable repair prompt.** A raw boot log isn't enough — extract the
   concrete error (unresolved module, TS error, missing env) and hand the agent a targeted task.
4. **Keep it bounded and non-infinite.** Every healing attempt consumes a cycle + commits; respect the
   existing budgets and closing-window drain. Never loop forever.
5. **Fixes before healing.** The deps/timeout fixes (issues 1-2) land first and independently — they
   reduce how often healing is even needed.

---

## 2. Part A — Boot reliability fixes (issues 1 & 2)

### A1. Tolerant, longer FE ready detection
**File**: `src/services/orchestration/runtime-gate-config.ts`

- Raise Expo/web frontend `timeoutMs` from 30s to **120s** (configurable). Bundling is slow; 30s is the
  single biggest cause of false FE failures.
- Make the Expo `readySignal` tolerant: accept ANY of several patterns instead of one literal. Today the
  gate matches a single `readySignal` substring (`runtime-gate.ts:166`). Change `readySignal: string` →
  support `readySignals: string[]` (keep `readySignal` as back-compat single). For Expo web, match any of:
  `'Waiting on http'`, `'Bundled '`, `'ready in'`, `'Web is waiting'`, `'Logs for your project'`.
- Same tolerance for Nest backend (`'Nest application successfully started'` is reliable — keep, but also
  accept `'Application is running on'`).

### A2. Refresh base node_modules when a task changed dependencies
**Files**: `run-autonomous-agent.ts` (before the runtime gate), `git.ts` (reuse `installWorkspaceDependencies`)

- Track during the run whether any integrated task's `writeScope`/diff touched a `package.json` or lock
  file (we already have `taskMayModifyDependencies` in worktree-manager — extract/share it).
- If so, before the final runtime gate, run a base-workspace `npm install` for the affected package dirs
  (reuse `installWorkspaceDependencies` from `git.ts`). This closes the "added a dep, base never got it"
  gap. Cheap when nothing changed (skip), correct when it did.

### A3. Stronger node_modules validity check
**File**: `runtime-gate.ts` (`hasNodeModules`)

- `hasNodeModules` currently only checks the dir exists. Add a light sanity check: dir exists AND is
  non-empty (has at least `.package-lock.json` or a known dep dir). Prevents a broken/empty symlink from
  being treated as "installed". Low risk, guards issue 2(c).

> Part A alone should make FE+BE boot in the common case. It's independently shippable and testable.

---

## 3. Part B — FE+BE runtime auto-healing (issue 3)

### B1. Extract a reusable runtime-gate runner that returns structured failures
**File**: `runtime-gate.ts`

- `startService` already returns `{ error }` with the captured boot log. Surface that structured error up
  through `runProjectRuntimeGate` as a typed result: `{ status, failures: Array<{ service, kind, detail,
  rawLog }> }` where `kind ∈ { 'unresolved-module' | 'compile-error' | 'missing-env' | 'port' | 'unknown' }`,
  classified by regex over the boot log (e.g. `Unable to resolve "X"` → unresolved-module with the module
  name; `error TS\d+` → compile-error; etc.).

### B2. Turn a runtime failure into a repair task
**File**: `run-autonomous-agent.ts` (new helper `buildRuntimeRepairTasks`)

- Map each structured failure to a `PlanTaskDraft` with a targeted prompt, e.g.:
  - unresolved-module `@expo/google-fonts/poppins` → "The app fails to boot: Unable to resolve
    '@expo/google-fonts/poppins' in <file>. Fix the import/dependency so the app bundles. Do not change
    unrelated code." + `writeScope` = the offending file (parsed from the log's import stack).
  - compile-error → the TS error + file/line, scoped to that file.
  - missing-env → surface as a warning (don't auto-invent secrets — respect the security rule).
- These drafts feed the EXISTING `createImprovementTasks` path.

### B3. Make the runtime gate part of the heal loop
**File**: `run-autonomous-agent.ts`

- Today: task loop closes → runtime gate runs once (line ~1406) → summary.
- New: after the task loop drains, run the runtime gate. If it **fails** AND
  `improvementCycle < maxImprovementCycles` AND budget remains:
  1. Classify failures (B1), build repair tasks (B2).
  2. Inject them via `createImprovementTasks`, set run status `healing`, `improvementCycle++`.
  3. **Re-enter the task loop** to execute the repair tasks (they integrate like any task).
  4. Re-run the runtime gate. Repeat until it passes or budget/cycles exhausted.
- Structure: wrap "task-loop + runtime-gate" so the runtime gate's repair tasks re-trigger the loop. The
  cleanest shape is a `do { runTaskLoop(); rt = runtimeGate(); } while (rt.failed && canHealMore())`.

### B4. Healing respects all existing budgets
- Each healing iteration consumes an `improvementCycle` and commits; honor `maxImprovementCycles`,
  `maxCommits`, `maxHours`, and the closing-window `gracefulDrainRequested` (no new healing once draining).
- Final outcome: if runtime still fails after exhausting cycles → `completed_with_warnings` (as today),
  but now with the repair attempts recorded. If it passes after healing → `completed`.

---

## 4. Files touched (summary)

| Part | File | Change |
|------|------|--------|
| A1 | `runtime-gate-config.ts` | FE timeout 30s→120s; `readySignals[]` tolerant matching |
| A1 | `runtime-gate.ts` | match any of `readySignals` |
| A2 | `run-autonomous-agent.ts`, `git.ts` | base `npm install` before final gate if deps changed |
| A3 | `runtime-gate.ts` | stronger `hasNodeModules` |
| B1 | `runtime-gate.ts` | structured, classified failure result |
| B2 | `run-autonomous-agent.ts` | `buildRuntimeRepairTasks()` (failure → PlanTaskDraft) |
| B3 | `run-autonomous-agent.ts` | runtime gate inside a heal loop (`do/while`) |

---

## 5. Verification plan

- **A1**: run the runtime gate against the real kubo Expo app; confirm it now waits long enough and
  detects ready (no false 30s timeout). Confirm Nest still detected.
- **A2**: in a run where a task adds a dependency, confirm the base `node_modules` gets it before the gate
  (no "Unable to resolve" for the new dep).
- **A3**: point a service at an empty/symlink-broken `node_modules`; confirm it triggers install, not a
  false pass.
- **B (healing)**: seed a deliberate boot failure (e.g. a bad import like the `@expo/google-fonts` one).
  Confirm: gate fails → repair task created with the right `writeScope` → task fixes it → gate re-runs →
  passes → run ends `completed`. Confirm it stops after `maxImprovementCycles` if unfixable.
- **Regression**: a run with no runtime issues behaves exactly as today (gate runs once, passes, no extra
  cycles, same summary).

---

## 6. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Heal loop runs forever / burns budget | Hard-bound by `maxImprovementCycles` + commits + hours + closing-window drain (B4) |
| Repair task edits unrelated code chasing a boot error | Scoped prompt + `writeScope` parsed from the import stack; reuse the "stay in scope" contract |
| Longer FE timeout makes runs slower | Only the FE service waits longer, and only when it hasn't signalled ready; passing apps are unaffected |
| Base reinstall is slow every run | Gate it on "a task actually touched package.json/lock"; skip otherwise |
| Misclassifying a boot log → wrong repair | Unknown/ambiguous failures fall back to a generic "app fails to boot: <log>" task, or just warn (no destructive guess) |
| Healing masks a real problem the user should see | Every heal attempt is logged as events + artifacts; summary shows attempts made |

---

## 7. Suggested implementation order

1. **A1** (timeout + tolerant ready) — smallest, highest immediate impact on "FE never runs".
2. **A3** (node_modules validity) — tiny, derisks symlink edge cases.
3. **A2** (base reinstall on dep change) — closes the "added a dep" gap.
4. **B1** (structured failures) — foundation for healing, no behavior change yet.
5. **B2 + B3 + B4** (repair tasks + heal loop) — the actual auto-healing, on top of the now-reliable gate.

Ship A first (boot reliability), verify FE+BE actually run, THEN layer B (healing) on top.

---

## 16. Implementation Status & Open Items (as of 2026-06-16)

> This section is the **resume point**. The healing work was built and iterated over several
> real runs; the bugs found along the way are recorded here so we don't re-discover them.

### ✅ Done & verified individually

| Piece | Status | Evidence |
|-------|--------|----------|
| **A1** — FE timeout 30s→120s, tolerant `readySignals[]` | Done | `runtime-gate-config.ts` |
| **A2** — base `npm install` when a task touched package.json | Done & seen working | run log: `node_modules restored via auto-install` |
| **A3** — stronger `hasNodeModules` (non-empty), `CI=1` env | Done | `runtime-gate.ts` |
| **B1** — structured classified failures (`RuntimeFailure`, `classifyFailure`) | Done & tested | classifies real font/Nest/port logs incl. ANSI + JSON-escaped quotes |
| **B2** — `buildRuntimeRepairTasks` (failure→scoped PlanTaskDraft, `kind:'heal'`) | Done & tested | env-missing correctly NOT auto-fixed (security) |
| **B3/B4** — heal loop, bounded, reuses `createImprovementTasks` | Done & verified reached | `run.heal_phase: canHeal=true`, `healing checks: 1` |
| **BE healing end-to-end** | ✅ VERIFIED | run_26b357f7: `findByClub` compile error → repair task → NestJS booted clean |
| **Bundle check via `expo export`** | ✅ VALIDATED LIVE | kubo-mobile: `expo export --platform web` exit 0 in 19s, all routes clean |

### 🐛 Bugs found & fixed during verification (do NOT reintroduce)

1. **Healing coupled to `maxImprovementCycles`** — user's policy has it at 0, so `0<0` killed
   healing. Fix: dedicated `maxRuntimeHealCycles` (default 3) in `AutonomousRunPolicy` +
   `?? 3` in `normalizePolicy` so persisted policies get it without reconfig.
2. **Healing lived INSIDE the task `while`** — a resumed run (all tasks already done) never
   re-entered the loop, skipping healing. Fix: moved healing to a dedicated phase AFTER the
   task loop, wrapped both in an OUTER `while (healingPassPending)` loop so it runs always and
   can re-enter to execute repair tasks.
3. **HTTP bundle-probe was fundamentally broken on modern Expo** — Metro's bundle URL changed
   across versions (Expo 54/expo-router 6 gave false 404s no matter the path:
   `/index.bundle`, `/expo-router/entry.bundle`, virtual entry...). Fix: REPLACED HTTP probe
   with a **command** check (`bundleCheckCommand`): Expo → `npx expo export --platform web
   --output-dir .unity-bundle-check`; Next/Vite → `npm run build`. Runs BEFORE the dev server,
   classifies from stdout/stderr, cleans the throwaway output dir.

### 🔁 Recurring operational gotcha

Editing files mid-run reloads `core` via `tsx watch` → the in-flight run is detected as
interrupted and **resumes from crash checkpoint**, which muddied 3 separate verification runs.
**Rule: do NOT edit files while a verification run is live.** (It is NOT caused by stuck DB
runs — `/api/runs/resumable` was 0.)

### ⏳ OPEN — finish this later

1. **Verify the full FE heal cycle end-to-end in ONE clean run** (no mid-run edits): FE has a
   real import error (e.g. the `@expo/google-fonts` scope typo) → `expo export` catches it →
   heal loop creates a scoped repair task → agent fixes it → re-check passes → run ends
   `completed`. All sub-pieces are proven; the joined cycle is not yet observed.
2. **Remove the temporary diagnostic events** `run.exec_enter` and `run.heal_phase` from
   `run-autonomous-agent.ts` once #1 is confirmed.
3. **Decide healing scope for FE vs BE precedence** — current gate starts backends first; if
   both fail, only the first failure is returned per gate run (healing iterates, so it gets to
   the FE on the next round, but confirm this multi-failure sequencing behaves under budget).
4. **Watch the runtime-gate process cleanup** — observed `:3000`/`:8081` left alive after a
   run (services not always killed on close). Not fatal (killPort handles next run) but worth
   tightening so stray dev servers don't accumulate.
