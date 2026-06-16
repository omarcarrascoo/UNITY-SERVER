# Phase A — A2A Foundations (HTTP) + Approval Gateway

> **Goal of this phase**: turn brain-station's *in-process pipeline* into a *real, multi-process agent
> network* using the **official A2A JavaScript SDK over HTTP**, **without changing what the agents actually
> do yet**, and add a Human Approval Gateway so any agent can pause and ask for authorization through the
> existing Discord channel.
>
> **Status**: Design (not yet implemented)
> **Stack locked**:
> - Agent↔agent: **`@a2a-js/sdk`** (real runtime dependency) — `AgentCard`, `AgentExecutor`, `Task`,
>   `Message`, `Artifact`, JSON-RPC over HTTP. Transport is HTTP from day one.
> - Agent→tools: `@modelcontextprotocol/sdk` (Phase B).
> **Topology**: **2 OS processes** on one host (localhost):
> - `core` — Discord bot + HTTP panel (:4477) + **PM Agent (A2A server :5000)** + `unityStore` (SQLite
>   owner) + Approval Gateway.
> - `dev-squad` — **stateless** A2A server (:5001) wrapping the existing Explorer→Architect→Implementer
>   pipeline. Touches the git worktree on disk; never touches SQLite directly.

---

## 0. Why this phase exists (and what it is NOT)

Today's "multi-agent pipeline" (`src/services/ai/agent-roles.ts`) is **three async functions** —
`runExplorerAgent`, `runArchitectAgent`, `generateAndWriteCode` — sharing one process, one provider, and
communicating by **concatenating TypeScript structs into prompt strings** (`implementerContext`). No agent
identity, no messaging, no task lifecycle.

Phase A introduces a **real agent network across processes**:

- Each agent is an **A2A server** with its own `AgentCard` and HTTP endpoint.
- Agents talk via **A2A Tasks/Messages/Artifacts** over JSON-RPC, not string concatenation.
- A **PM Agent** (inside `core`) is the single entry point the human (Discord/panel) talks to.
- An **Approval Gateway** lets any agent enter A2A's `input-required` state and wait for a human click.

**Phase A explicitly does NOT:**
- Add Slack/Jira/Google Ads (that's Phase B — MCP clients).
- Add Design/Marketing squads (Phase D).
- Remove the single-run mutex or wire the dead TaskQueue (Phase C — concurrency).
- Move agents onto separate *hosts* (Phase E+ — Phase A is multi-process, single-host).
- Change the prompts, models, gates, or git logic of the existing Dev pipeline.

> **The discipline**: Phase A is a *refactor onto an HTTP message protocol*, not a behavior change. After
> Phase A, a run produces the **same output** as today — it just flows over A2A between two processes
> instead of direct function calls. This makes Phase A verifiable: same input → same PR.

---

## 1. The core architectural decision: real A2A/HTTP from day one

We adopt the **official A2A SDK as a runtime dependency** and run agents as **separate OS processes**
talking JSON-RPC over localhost. Chosen deliberately over an in-memory bus because brain-station's roadmap
is genuinely distributed:

- Marketing (Puppeteer + Google Ads + posting) is heavy, blocking I/O that must **not** sit on the PM's
  event loop — a hung browser must not take down the orchestrator.
- Multiple brain-station instances are an explicit goal.
- Concurrent multi-run execution is a hard requirement, not a nice-to-have.

An in-memory bus would be throwaway work the moment the first squad moves out-of-process. We pay the HTTP
toll once, now.

### What this decision *forces* into Phase A scope (and how we handle it)

| Forced concern | Why it appears | Resolution in Phase A |
|---|---|---|
| **SQLite single-writer** (`unityStore` is a singleton, `runtime/services.ts`) | A second process can't safely share the handle | **Dev Squad is stateless**: it never opens SQLite. It reports lifecycle via A2A events; the `core` process (DB owner) persists them via the task-bridge (§8). |
| **Shared state can't pass by reference** | `baseWorkspace`, `RuntimeState`, `AbortController` are objects | Only **JSON-serializable** data crosses the wire. Git worktree is shared by **path string** (same host = shared filesystem). Cancellation uses A2A `cancelTask`, not a passed `AbortController`. |
| **N processes to run/supervise** | Two servers instead of one | A `concurrently`-style dev script + a `procs/` entrypoint per process (§10). Single-host, so logs stay local. |
| **PM must co-reside with Discord + DB** | Approval needs Discord; persistence needs the DB | PM Agent's A2A server is **hosted inside the `core` process**, not its own process. Only Dev Squad is a separate process in Phase A. |

> **Risk that stays eliminated**: DeepSeek's `reasoning_content` echo rules (see `agent-runner.ts`) don't
> break, because the **LLM loop stays inside the Dev Squad executor**. A2A carries only the delegation and
> the result — never raw LLM turns. There is no serialization boundary inside the model loop.

> **DeepSeek note**: DeepSeek is already behind `LLMProvider` (`providers/types.ts`) — orthogonal to this
> decision. Agents talk A2A regardless of which model backs the provider.

---

## 2. Design principles

1. **Wrap, don't rewrite.** The existing `agent-roles.ts` functions stay. We wrap them in an
   `AgentExecutor`. Their logic, prompts, and tool runtime are untouched.
2. **The human front-end is sacred.** Discord (`register-handlers.ts`) and the HTTP panel (`server.ts`)
   keep working exactly as they do. They become **A2A clients of the PM Agent** — additive, not replacing.
3. **Dev Squad is stateless.** It receives a delegation, runs the pipeline against a worktree path, and
   reports via A2A events/artifacts. It owns no database and no long-lived run state.
4. **Only serializable data crosses the wire.** No object references, no singletons reached through a
   message. This is the rule that keeps multi-process honest.
5. **Persistence stays centralized.** Lifecycle maps onto existing `RunRecord`/`TaskRecord` in `unityStore`,
   written **only** by `core`. No 5th database.

---

## 3. New folder structure

```
src/
  a2a/                          ← NEW
    cards/                      ← AgentCard definitions (identity + capabilities)
      pm.card.ts
      dev-squad.card.ts
    executors/                  ← AgentExecutor implementations (wrap existing logic)
      pm.executor.ts            ← orchestrates: planAutonomousRun, delegates to dev-squad over A2A
      dev-squad.executor.ts     ← wraps runAgentPipeline + generateAndWriteCode (stateless)
    server/
      a2a-server.ts             ← shared helper: express + jsonRpcHandler + agent-card route
      ports.ts                  ← central port registry (PM=5000, devSquad=5001)
    clients/
      dev-squad.client.ts       ← typed A2A client (ClientFactory.createFromUrl + sendMessageStream)
    approval/
      approval-gateway.ts       ← bridges input-required ↔ Discord buttons
      approval-store.ts         ← pending approvals keyed by taskId (Map<taskId,{resolve,...}>)
    shared/
      delegation.ts             ← serializable delegation/result message shapes (Part encoders/parsers)
      task-bridge.ts            ← consumes A2A lifecycle events → unityStore (core only)
  procs/                        ← NEW — process entrypoints
    core.ts                     ← (was index.ts) Discord + panel + PM A2A server + DB + approval
    dev-squad.ts                ← starts only the Dev Squad A2A server
  ...
```

`index.ts` is superseded by `procs/core.ts` (it keeps everything it does today and adds the PM A2A server
+ the Dev Squad client). `procs/dev-squad.ts` is a new, small entrypoint.

---

## 4. The A2A servers (real, over HTTP)

A shared helper stands up any agent as a spec-compliant A2A server (JSON-RPC + agent-card discovery):

```typescript
// src/a2a/server/a2a-server.ts  (shape, not final)
import express from 'express';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';

export function startA2AServer(card: AgentCard, executor: AgentExecutor, port: number) {
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: handler }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  return app.listen(port, '127.0.0.1', () => console.log(`🛰️  ${card.name} A2A server on :${port}`));
}
```

> `InMemoryTaskStore` is the SDK's protocol-level bookkeeping inside each process. It is **not** our
> persistence — `core`'s task-bridge mirrors the meaningful lifecycle into SQLite (§8). `noAuthentication`
> is fine on localhost in Phase A; auth is a Phase E concern when agents leave the host.

---

## 5. A2A primitives mapped onto brain-station

| A2A primitive | brain-station meaning | Backed by |
|---|---|---|
| **AgentCard** | Identity + capabilities of PM / Dev Squad | `src/a2a/cards/*` |
| **Task** (`contextId`, `id`) | One delegated unit; `contextId` = brain-station `runId` | `task-bridge.ts` → `unityStore` (core) |
| **Message** (`role`, `parts`) | A delegation ("build feature X") or a human reply ("approved") | A2A SDK |
| **Artifact** | The diff / commit message / PR URL a squad returns | `unityStore.addArtifact` (core) |
| **TaskState** `submitted→working→completed/failed` | Mirrors `RunStatus` / `TaskStatus` | `task-bridge.ts` |
| **TaskState `input-required`** | **Agent is waiting for human authorization** | `approval-gateway.ts` (core) |
| **`cancelTask`** | Run/task cancellation (replaces passed `AbortController`) | SDK client → executor |

> **`input-required`** is a paused, non-terminal state: an agent publishes
> `{ kind:'status-update', status:{ state:'input-required' }, final:true }` to suspend, and the flow
> resumes when a new `Message` with the same `taskId`+`contextId` arrives. Since the approving party (PM)
> lives in `core` with Discord, the resume message is generated locally on button click (§9).

---

## 6. The AgentCards (cheap to decide now, expensive to change later)

### 6.1 PM Agent — hosted in `core`, the entry point the human talks to

```typescript
// src/a2a/cards/pm.card.ts
import type { AgentCard } from '@a2a-js/sdk';
import { PORTS } from '../server/ports.js';

export const pmAgentCard: AgentCard = {
  name: 'PM Agent',
  description: 'Receives an objective, plans it, delegates to squads, tracks status, brokers human approvals.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: `http://127.0.0.1:${PORTS.pm}/a2a/jsonrpc`,
  capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    { id: 'run-initiative', name: 'Run Initiative',
      description: 'Plan and execute a development objective end to end.', tags: ['planning', 'orchestration'] },
    { id: 'report-status', name: 'Report Status',
      description: 'Return the current state of a run/initiative.', tags: ['tracking'] },
  ],
};
```

### 6.2 Dev Squad Agent — separate process, wraps today's pipeline

```typescript
// src/a2a/cards/dev-squad.card.ts
export const devSquadAgentCard: AgentCard = {
  name: 'Dev Squad',
  description: 'Explorer→Architect→Implementer→Reviewer pipeline that turns a scoped task into a committed diff.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: `http://127.0.0.1:${PORTS.devSquad}/a2a/jsonrpc`,
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    { id: 'implement-task', name: 'Implement Task',
      description: 'Given a scoped instruction + writeScope + worktree path, produce a validated commit.',
      tags: ['code', 'implement'] },
  ],
};
```

> Phase A ships **exactly two agents**. Design/Marketing cards come in Phase D. Two agents prove the
> cross-process A2A loop without a combinatorial explosion of servers.

---

## 7. The AgentExecutor adapters (the refactor)

### 7.1 Dev Squad executor — stateless wrapper over existing code

Receives a delegation Message, runs the **existing** pipeline against a worktree path, publishes A2A
events. **Zero changes to `runAgentPipeline` / `generateAndWriteCode`. No SQLite access.**

```typescript
// src/a2a/executors/dev-squad.executor.ts  (shape, not final)
class DevSquadExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const d = parseDelegation(userMessage); // { repoPath, userPrompt, writeScope, runId, taskId, projectName }

    if (!task) bus.publish(initialTask(taskId, contextId, userMessage)); // submitted
    bus.publish(statusUpdate(taskId, contextId, 'working', false));

    // ── existing logic, unchanged; LLM loop stays in-process here ──
    const pipeline = await runAgentPipeline({ repoPath: d.repoPath, userPrompt: d.userPrompt,
      writeScope: d.writeScope, /* ... */
      onProgress: (m) => bus.publish(statusUpdate(taskId, contextId, 'working', false, m)) });
    const result = await generateAndWriteCode({ repoPath: d.repoPath, userPrompt: d.userPrompt,
      architectContext: pipeline.implementerContext, /* ... */ });

    bus.publish(artifactUpdate(taskId, contextId, {
      artifactId: 'result',
      parts: [{ kind: 'text', text: JSON.stringify({                 // serializable result
        commitMessage: result.commitMessage, targetRoute: result.targetRoute,
        tokenUsage: result.tokenUsage, iterations: result.iterations,
        filesRead: result.filesRead, toolHistory: result.toolHistory }) }],
    }));
    bus.publish(statusUpdate(taskId, contextId, 'completed', true));
    bus.finished();
  }
  cancelTask = async () => { /* abort the in-flight pipeline for this taskId */ };
}
```

> The Dev Squad does **not** commit/cherry-pick/push. It produces the diff in the worktree and returns the
> metadata. **`core` keeps ownership of git integration** (`integrateTaskResult`, branch-manager) and DB
> writes — exactly as today. This keeps the dangerous, stateful operations in one place.

### 7.2 PM executor — orchestration moves here, gradually

In Phase A the PM executor does the **minimum** to prove the cross-process loop:

1. Receives the human objective (from Discord) as an A2A Message.
2. Calls the **existing** `planAutonomousRun` (no change).
3. Creates the worktree for the **first task only** (existing `createTaskWorktree`), then delegates to the
   Dev Squad **over A2A** (`devSquadClient.sendMessageStream`, §7.3 path) instead of calling the pipeline
   in-process.
4. Consumes Dev Squad's event stream, mirrors it to `unityStore` (task-bridge), and on `completed` runs the
   **existing** integration path (`integrateTaskResult`) and the existing gates/reviewer.

> Pilot delegation is behind `A2A_DELEGATE=1`. The full parallel batch stays on the current in-process
> `Promise.all` path until Phase C. One task proves the wire format before the whole orchestrator moves.

### 7.3 What `run-autonomous-agent.ts` looks like after Phase A

`executeTask` gains a branch at the *implementation* step only:

```text
create worktree (unchanged)
if (A2A_DELEGATE && task is the pilot)  → delegate to dev-squad via A2A; await result metadata
else                                    → existing in-process runAgentPipeline + generateAndWriteCode
commit / scope-gate / reviewer / integrate (UNCHANGED — stays in core)
```

The 1872-line orchestrator is **not** rewritten. The git/gate/review/integration tail is identical; only
*who runs the LLM pipeline* changes for the pilot task.

---

## 8. Task persistence bridge (core-only)

Because Dev Squad is stateless, persistence is cleaner than a shared DB:

- `task-bridge.ts` runs in `core`, consumes the A2A event stream returned by `sendMessageStream`, and
  mirrors lifecycle into `unityStore` via current helpers (`addEvent`, `addArtifact`, `updateTask`).
  `contextId === runId` is the join key.
- Each SDK server keeps its own `InMemoryTaskStore` for protocol bookkeeping; that is ephemeral and
  process-local. The **durable** truth is `unityStore`, written only by `core`.
- The panel keeps reading `unityStore` exactly as today — unaware that work happened in another process.

---

## 9. The Approval Gateway (your "ask Discord before acting" requirement)

Highest-value new capability in Phase A; directly serves the Phase D marketing-authorization need. Because
the PM lives in `core` alongside Discord, approval needs **no webhook/push** — the resume is generated
locally on the button click.

### 9.1 Flow

```
Agent (in core) needs human OK
      │
      ▼
publish status-update { state:'input-required', final:true }   ← suspend the task (panel/stream see it)
      │
      ▼
const decision = await approvalGateway.requestApproval({ taskId, contextId, question, payload })
      │        (awaits a promise in approval-store, keyed by taskId)
      ▼
Discord: post message + ✅ Approve / 🗑️ Reject buttons   ← REUSES register-handlers.ts:359 pattern
      │
      ▼ (human clicks)
interactionCreate handler → approvalGateway.resolve(taskId, decision)   ← resolves the pending promise
      │
      ▼
requestApproval() returns → agent continues from where it paused
```

> If a squad in **another process** ever needs approval (Phase D, e.g. marketing posting), it emits
> `input-required` over A2A; `core` surfaces the buttons and, on click, sends the resume Message back over
> A2A. Phase A only needs the in-`core` path, but the design is forward-compatible.

### 9.2 Why this maps cleanly onto existing code

- Discord **button pattern already exists** for session approve/reject (`register-handlers.ts:359`,
  `buildSessionButtonId`, `parseButtonContext`). The gateway reuses the same `customId` encoding, swapping
  `session` semantics for `approval:<taskId>`.
- `approval-store.ts` is a `Map<taskId, { resolve, payload, expiresAt }>` — same shape as the existing
  `sessionStore` in `runtime/state.ts`. Timeout/cleanup mirrors `cleanupLostSession`. Double-click = no-op.

### 9.3 Phase A trigger (safe)

To prove the gateway with no external/public action, the **PM Agent requires human approval of the plan
via this gateway** (alongside the current console approve). Demoable moment: *"Discord shows the plan with
Approve/Reject buttons; clicking Approve resolves the pending approval and the Dev Squad (other process)
starts."*

---

## 10. Process model & bootstrap

```typescript
// src/a2a/server/ports.ts
export const PORTS = { pm: 5000, devSquad: 5001 } as const;
```

```typescript
// src/procs/dev-squad.ts  (separate process)
import 'dotenv/config';
import { startA2AServer } from '../a2a/server/a2a-server.js';
import { devSquadAgentCard } from '../a2a/cards/dev-squad.card.js';
import { DevSquadExecutor } from '../a2a/executors/dev-squad.executor.js';
import { PORTS } from '../a2a/server/ports.js';

startA2AServer(devSquadAgentCard, new DevSquadExecutor(), PORTS.devSquad);
```

```typescript
// src/procs/core.ts  (was index.ts — keeps everything it did, adds PM server + dev-squad client)
registerDiscordHandlers(client, runtime);                 // unchanged
startUnityHttpServer(runtime);                            // unchanged (:4477)
startA2AServer(pmAgentCard, new PMExecutor(runtime), PORTS.pm);  // NEW — PM A2A server in-core
client.login(config.discordToken);
```

`package.json` scripts:

```jsonc
"dev":          "concurrently -n core,dev "tsx watch --ignore workspaces/ src/procs/core.ts" "tsx watch --ignore workspaces/ src/procs/dev-squad.ts"",
"dev:core":     "tsx watch --ignore workspaces/ src/procs/core.ts",
"dev:dev-squad":"tsx watch --ignore workspaces/ src/procs/dev-squad.ts"
```

`.env` gains: `A2A_PM_PORT`, `A2A_DEV_SQUAD_PORT` (optional overrides), `A2A_DEV_SQUAD_URL` (core→dev-squad
client target, default `http://127.0.0.1:5001`), and the `A2A_DELEGATE` feature flag. New dep:
`concurrently` (dev only).

---

## 11. Scope boundary — what ships in Phase A

| Included ✅ | Deferred ⛔ |
|---|---|
| `@a2a-js/sdk` as a runtime dep; PM (in core) + Dev Squad (own process) as A2A servers | Slack / Jira / Ads (Phase B, MCP) |
| Dev Squad executor wrapping existing pipeline, **stateless** | Design / Marketing squads (Phase D) |
| PM delegates **one pilot task** to Dev Squad over A2A | Full parallel batch over A2A (Phase C) |
| `core` keeps git integration + DB writes + gates/reviewer | Dev Squad doing its own commit/push |
| Approval Gateway (Discord buttons ↔ `input-required`) | Removing single-run mutex / wiring TaskQueue (Phase C) |
| Task-bridge mirroring A2A events → unityStore (core) | A separate/shared SQLite writer in dev-squad |
| 2-process model on one host; Discord/panel unchanged | Multi-**host** deployment, auth between agents (Phase E) |

---

## 12. Implementation steps (ordered, each independently testable)

1. **SDK smoke test across processes.** Add `@a2a-js/sdk` + `concurrently`. Stand up a throwaway "hello"
   A2A server on :5001 (`procs/dev-squad.ts` stub) and a client script in `core` that hits it. Confirms the
   SDK works in this ESM/tsx setup **and** that two `tsx watch` processes coexist — *before* touching
   brain-station code.
2. **Cards + servers + process split.** Add `cards/`, `a2a-server.ts`, `ports.ts`; create `procs/core.ts`
   (from `index.ts`) and `procs/dev-squad.ts`. Both cards reachable at
   `/.well-known/agent-card.json` on their ports.
3. **Dev Squad executor (stateless wrap).** Implement `DevSquadExecutor` calling the existing pipeline
   against a `repoPath` from the delegation. Test by sending it a delegation Message **directly** (PM not
   involved) and asserting a real diff appears in the worktree + result metadata comes back.
4. **Dev Squad client + task-bridge.** Add `dev-squad.client.ts` and the A2A→unityStore mirror in `core`.
   Verify the panel shows the delegated task's events while the work ran in the other process.
5. **PM executor + pilot delegation.** Behind `A2A_DELEGATE=1`, PM creates the worktree, delegates the
   first task to Dev Squad over A2A, then runs the **existing** commit/gate/review/integrate tail in `core`.
   Verify same PR as the non-flagged run.
6. **Approval Gateway.** Implement `approval-store.ts` + `approval-gateway.ts`; extend the Discord
   `interactionCreate` handler. Route plan approval through `requestApproval()`. Verify click-to-resume
   starts the other process's work.

> Steps 1–4 add behavior without changing existing runs. Step 5 is the only behavior-adjacent change and
> it's flag-gated. Step 6 changes where the approve click is surfaced (console → also Discord).

---

## 13. Verification plan

| Step | How to verify | Pass criteria |
|---|---|---|
| 1 | Run the two-process smoke test | Client in core receives `Hello` from :5001; both watchers stay up |
| 2 | `curl http://127.0.0.1:5000/.well-known/agent-card.json` and :5001 | Both AgentCards returned |
| 3 | Send a delegation Message to Dev Squad directly | Real diff in worktree + serializable result metadata |
| 4 | Run a delegated task, open the panel | Task events/artifacts appear in `unityStore`-backed UI (written by core) |
| 5 | Same prompt with `A2A_DELEGATE` on vs off | Equivalent PR / diff; A2A path shows cross-process status stream |
| 6 | Trigger plan approval; click Approve in Discord | Paused task resumes; Dev Squad (other process) starts within seconds |

**Regression guard**: pick one historical prompt that produced a clean PR today. After Phase A, the same
prompt (flag on) must still produce an equivalent PR. If not, the wrapper leaked behavior — fix before
proceeding.

---

## 14. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Worktree path coordination** between core (creates) and dev-squad (writes) | Medium | Pass absolute `repoPath` in the delegation; both processes share the host filesystem. Assert path exists at executor entry. |
| **Non-serializable leakage** (someone passes an object/handle through a Message) | **High** | Lint rule + `delegation.ts` as the *only* encoder/parser; payloads are plain JSON. Step 3 test asserts a clean round-trip. |
| Process A dies, the other is orphaned | Medium | `concurrently --kill-others` in dev; for prod, a supervisor (pm2/systemd) — noted for Phase C, acceptable manual restart in A. |
| A2A request timeout on long Dev Squad tasks (runs can be many minutes) | Medium | Use `sendMessageStream` (long-lived stream) not blocking `sendMessage`; rely on status updates as keep-alive. |
| DeepSeek `reasoning_content` echo rules break | **Eliminated** | LLM loop stays inside the Dev Squad executor; A2A carries only delegation + result. |
| Cancellation no longer just an `AbortController` ref | Medium | Implement `cancelTask` on the executor + call it from the client on Discord cancel; map to the pipeline's internal abort. |
| Scope creep into Phase B/C/D | **High** | §11 boundary table is the contract; anything external/concurrent/multi-host = stop, later phase. |

---

## 15. What this unlocks for later phases

- **Phase B (MCP)**: the stateless Dev Squad already isolates tool use; swapping `createAgentToolRuntime`
  for an MCP client is localized to that process. PM gains Slack/Jira MCP tools for traceability.
- **Phase C (concurrency)**: with delegation already over A2A, running N Dev Squad workers in parallel is a
  fan-out across instances + finally wiring the dead `TaskQueue`; the mutex in `register-handlers.ts:147`
  comes out here. SQLite stays single-writer in `core`, so no new locking problem.
- **Phase D (squads)**: Design/Marketing = new processes + cards + executors. The Approval Gateway built
  here is exactly what gates marketing's public posts (their `input-required` already routes to Discord).
- **Phase E (multi-host / external)**: agents already speak real A2A; going multi-host = real URLs in
  AgentCards + auth (`UserBuilder`) + push notifications for cross-host status. External agents (Claude
  Code, third parties) can drive brain-station through the same protocol.
```
