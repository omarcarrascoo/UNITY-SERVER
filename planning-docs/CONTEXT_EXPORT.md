# brain-station — Full Context Export

> Single-document snapshot of the multi-session work turning brain-station from a
> single autonomous-code orchestrator into a **holistic "agent company"**.
> Portable: hand this to another conversation, teammate, or repo to get up to speed.
> Last consolidated: 2026-06-17.
>
> Detailed per-topic notes live in `~/.claude/projects/<this-project>/memory/*.md`
> (auto-loaded by new conversations IN this project). This file mirrors them for portability.

---

## 1. What brain-station is

The **control plane** (not the product): it plans, writes, validates, reviews, and
integrates code in *other* git repos on the user's behalf. Surfaces: a **Discord bot**
+ a **local HTTP panel** (`:4477`). Backed by SQLite stores under `.unity/`. LLM engine
is **DeepSeek `deepseek-v4-pro`** behind an `LLMProvider` abstraction. Mature (its own
docs claim Phases 0-8 complete). Target test repo: `mono-repo-kubo` (Expo FE `kubo-mobile`
+ NestJS BE `infra-red`).

## 2. The vision (north star)

A **company of agents** communicating agent-to-agent:
- **PM Agent** — receives objectives, routes/dispatches to the right agent, tracks status.
- **Dev Squad** — the existing Explorer→Architect→Implementer→Reviewer pipeline (real).
- **Marketing Squad** — drafts + posts content, but MUST get human approval before public actions.
- **Market Research / Sales / QA / Security / Product-Owner** — future analysis agents.

Hard requirements: traceability (tickets), keep Discord+panel as the human front-end,
human authorization for outward/public actions, a mobile app will consume the APIs.

## 3. Tech-stack decisions (locked)

- **Agent↔agent (horizontal): `@a2a-js/sdk`** (official A2A SDK), real runtime dep, JSON-RPC over HTTP, multi-process on one host. AgentCard/AgentExecutor/Task/Message/Artifact.
- **Agent→tools (vertical): `@modelcontextprotocol/sdk`** — DEFERRED. Not needed yet; traceability went in-house instead of Slack/Jira. MCP returns when a genuinely external tool is needed (real social posting, Google Ads).
- **Topology:** `core` process (Discord + panel + PM + Marketing + Market-Research A2A servers + SQLite + Approval Gateway) and a separate **stateless** `dev-squad` process. Ports: pm 5000, dev-squad 5001, marketing 5002, market-research 5003.
- **Key constraint:** only JSON-serializable data crosses A2A; the dev-squad is stateless (no SQLite, no commit/push — `core` owns git integration + DB writes); the LLM loop stays inside each executor (so DeepSeek's reasoning_content rules never break across the wire).

## 4. What's BUILT and verified

### A2A foundations (Phase A, Steps 1-5) ✅
- `src/a2a/`: `cards/` (AgentCards), `server/a2a-server.ts` (startA2AServer helper), `server/ports.ts`, `executors/`, `clients/`, `shared/` (delegation.ts = the serializable PM↔DevSquad contract; events.ts; task-bridge.ts mirrors A2A events → unityStore).
- `src/procs/core.ts` + `src/procs/dev-squad.ts` (index.ts is a shim → core). `npm run dev` runs both via `concurrently`.
- Dev Squad delegation works behind `A2A_DELEGATE=1`; `core` keeps the commit/gate/review/integrate tail. Verified with real DeepSeek delegation.

### Approval Gateway + Marketing Squad (Phase A, Step 6) ✅ — VERIFIED LIVE
- `src/a2a/approval/approval-gateway.ts`: SELECTIVE gate (NOT universal — Dev Squad doesn't use it; only outward public actions do). `requestApproval()` returns a promise resolved by a human Discord click; fails closed (no notifier / timeout → not approved). Transport-agnostic notifier.
- Discord buttons (`approve-appr:`/`reject-appr:`) wired in register-handlers.
- Marketing Squad (`runMarketingDraft`): brief → LLM draft → request approval → publish (MOCK) or cancel. **User confirmed live**: real Discord clicks → `Approved by omardamus → published` / `Not approved → NOT published`.

### Runtime reliability + FE/BE auto-healing ✅ (BE proven; FE built, FE-cycle not yet seen e2e)
- FE runtime timeout 30s→120s, tolerant `readySignals[]`.
- node_modules: auto-install if missing; base reinstall when a task touched package.json.
- **Bundle check via command** (`npx expo export --platform web` for Expo; `npm run build` for Next/Vite) — replaced a fragile HTTP bundle-probe that 404'd on modern Expo (expo-router). Validated live: `expo export` exit 0 in 19s.
- Auto-healing: runtime failure → classified (`unresolved-module`/`compile-error`/...) → scoped repair task via the existing improvement-cycle machinery, in an OUTER `while (healingPassPending)` loop so it runs even on resumed runs. Own budget `maxRuntimeHealCycles` (default 3, independent of maxImprovementCycles). **BE healing verified e2e** (a `findByClub` compile error was auto-repaired and NestJS booted). **FE heal cycle not yet seen end-to-end in one run.**

### Panel features ✅
- Project selector (persisted in localStorage; shows 🚀 for projects with deploy config).
- **Create PR** button → `POST /api/runs/:id/create-pr` (opens PR for the run's branch). NOTE: blocked by an INVALID `GITHUB_TOKEN` (401 — user regenerating a PAT with `repo` scope).
- **▶ Run Locally** button → `POST /api/runs/:id/run-local` (reuses runtime gate to boot FE+BE and leave them running, returns URLs). Replaced a "Deploy" button (user wanted to SEE the app, not publish).
- LESSON: run-page action buttons must be added to the CLIENT-side `actHtml` block, not just server-side `buildActionsHtml` (the client overwrites).

### In-house tickets / mini-Jira (Phase B) ✅
- `src/services/tickets/`: `ticket-store.ts` (own SQLite, status/source/**priority**/run links), `ticket-notifier.ts` (decoupled sink), `run-tickets.ts` (one auto ticket per run, opened on createRun, closed to done/blocked on run close).
- REST API: `GET/POST/PATCH/DELETE /api/tickets` (for panel AND mobile app). Panel `/board` page (kanban, create, move, priority badges, urgent-first sort).
- **Priority** field (low/normal/high/urgent) — foundation for future autonomous self-tasking.
- Discord notifications for ticket transitions (→done, →blocked, new manual).

### Channel separation ✅
- `UNITY_TICKETS_CHANNEL` + `UNITY_APPROVALS_CHANNEL` (fall back to autonomous channel if unset). Tickets → tickets channel, approvals → approvals channel, runs → autonomous channel.

### Agent registry + router (Roadmap part 3) ✅ — VERIFIED (12/12)
- `src/a2a/registry/`: `agent-registry.ts` (catalog: dev-squad/marketing/market-research with capability+keywords), `agent-router.ts` (LLM classifier + keyword fallback + default), `route-and-dispatch.ts` (routes then dispatches; dev-squad returns `needs-autonomous-run` since it needs the full pipeline). `clients/agent-client.ts` (generic dispatch). New **Market Research agent** (port 5003).
- Triggers: Discord `/ask <prompt> [agent]`, panel "🧭 Ask an Agent" section + `GET /api/agents` + `POST /api/route`.
- Verified: 12/12 routing correct (keywords + real LLM, EN+ES).

## 5. Operational notes / gotchas

- **Register slash commands** after changing them: `npx tsx utils/register-commands.ts` (commands: workon, status, policy, init, marketing, ask).
- **Editing files mid-run** reloads `core` via `tsx watch` → the live run "resumes from crash checkpoint" and skews verification. Don't edit during a verification run.
- `GITHUB_TOKEN` was invalid (401) — Create-PR needs a fresh PAT (scope `repo`).
- `publishPost` (marketing) is a MOCK — real posting is future (MCP/social).
- `deploy.ts` exists but is orphaned (kept for a future real-deploy feature; superseded by Run Locally).
- Another process added SSE streaming to the panel (`sse.ts`, `src/services/events/`) — not part of this work, left untouched.
- Recurring AGENT (not brain-station) bug: it writes `@expo/google-fonts/...` (slash) instead of `@expo-google-fonts/...` (hyphen). Rule added to `workspaces/mono-repo-kubo/unityrc.md` §3.7.

## 6. Roadmap & where we are

```
1) Cleanup                         ✅
2) Phase B in-house tickets        ✅ (+ channel split + priority)
3) Agent registry + router         ✅  ← just finished
4) Real publish/deploy             ⬜  ← NEXT
Later / the "flywheel":
  - Autonomous self-tasking (idle → pull top-priority ticket → build)
  - Analysis agents that FILE tickets: QA bot, Security bot, Product-Owner
    (synthesizes market research + competition + customer reviews → prioritized tickets)
  - Project-as-memory repos (.agent/ folders: marketing strategy, research, automations)
  - Automation flows (scheduled/triggered multi-agent chains)
  - Concurrency (kill the single-run mutex, wire the dead TaskQueue) — A2A/HTTP already enables it
```

Also still open from earlier phases: verify the FE auto-heal cycle end-to-end; PM
executor is still a stub (the router logic lives alongside it, not yet fused into the
PM A2A executor).

## 7. Design docs (in `planning-docs/`)

- `AGENT_COMPANY_VISION.md` — the north star, §1 router / §2 memory-repos / §3 automations / §4 self-tasking / §5 analysis agents / §6 channels.
- `A2A_PHASE_A_DESIGN.md` — the A2A/HTTP 2-process design.
- `RUNTIME_HEALING_DESIGN.md` — healing design + §16 status/open-items checklist.
- (this file) `CONTEXT_EXPORT.md` — the consolidated snapshot.
