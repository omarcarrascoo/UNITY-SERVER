# Agent Company — Future Vision & Architecture Notes

> Captured 2026-06-16 from the user's direction. This is the NORTH STAR for where
> the multi-agent system is going. Not all of this is built — it's here so we plan
> it well before implementing. Each item links to the phase that would deliver it.

---

## The big picture

brain-station is evolving from a single autonomous-code orchestrator into a
**holistic company of agents**. Today we have: PM (stub), Dev Squad (real), and a
minimal Marketing Squad (real, approval-gated). The vision is many more agents,
intelligently coordinated, with a rich shared project memory.

---

## 1. Agent selection + intelligent routing ("which agent answers?")

**User's words:** *"lo que estaría padre es poder seleccionar el agente con el que
estamos hablando... y que también el core pueda decidir qué agente usar dependiendo
del prompt del usuario."*

Two modes, both wanted:
- **Manual selection** — the human picks which agent to talk to (a selector in the
  panel / a Discord command).
- **Automatic routing** — the `core` (PM Agent) reads the user's prompt and decides
  which agent/squad should handle it. Examples the user gave:
  - "investiga el mercado" → spin up / route to a **Market Research agent**
  - "busca clientes" → a **Sales agent** that analyzes prospects for cold calls
  - "construye X" → Dev Squad (today's default)
  - "haz un post / campaña" → Marketing Squad

**Architecture implication:** this is an **Agent Registry + Router**. The PM Agent
becomes a real dispatcher: it knows the catalog of agents (their AgentCards/skills),
and either routes deterministically (keyword/skill match) or via an LLM classifier
over the prompt. A2A AgentCards already carry `skills[]` with `tags` — that's the
seed of the registry. This is the natural evolution of the PM executor (currently a
stub). **Likely a dedicated phase after Phase B/C.**

New agents the user explicitly anticipates (build on demand, not now):
- Market Research agent
- Sales / prospecting agent (analyze potential clients for cold outreach)
- (plus existing: Dev, Marketing, Design)

---

## 2. Project-as-memory repos (NOT just code)

**User's words:** *"organizar los repos de github... para que los agentes tengan ahí
una memoria del proyecto... un monorepo gigante que no solo incluya código (como
kubo), evolucionarlo para que se entienda perfecto el contexto del proyecto más allá
del código. Que haya carpetas donde se puedan guardar las estrategias de marketing."*

The idea: a project's GitHub repo is the **shared long-term memory** for ALL its
agents, not only the codebase. A monorepo with structured non-code context, e.g.:
```
<project>/
  kubo-mobile/        # FE code (exists)
  infra-red/          # BE code (exists)
  .agent/             # NEW — agent-readable project context
    marketing/        # strategies, brand voice, past campaigns
    research/         # market research outputs
    sales/            # prospect lists, outreach notes
    product/          # product brief, roadmap, decisions
    automations/      # automation flow definitions (see §3)
```
Agents read this context to act with full project understanding, and WRITE their
outputs back here (so work compounds across runs and across agents). This dovetails
with the existing knowledge graph (`unity-knowledge.sqlite`) but extends it to
human-readable, git-versioned artifacts.

**Architecture implication:** define a convention (`.agent/` or similar) + give each
squad's tool runtime read/write access to its folder. The Dev Squad already works
against the repo path; other squads would too. Marketing reads `.agent/marketing/`,
writes campaign drafts there, etc. Needs design: folder schema, who writes what,
how it feeds prompts.

---

## 3. Project automation flows

**User's words:** *"que pueda crear flujos de automatizaciones del proyecto."*

Beyond one-off runs: the user wants reusable, possibly scheduled/triggered
**automation flows** for a project — e.g. "every week, research competitors and draft
3 posts for approval", or "when a PR merges, notify Slack + update the roadmap doc".

**Architecture implication:** a flow definition (declarative, stored in
`.agent/automations/` per §2) that chains agents + triggers (schedule, webhook, manual)
+ approval gates where needed. This is where A2A really pays off — flows orchestrate
multiple agents. Connects to: the existing webhook transport, the Approval Gateway
(built in Phase A Step 6), and the agent router (§1).

---

## 4. Ticket priority + autonomous self-tasking (user, 2026-06-16)

**User's words:** *"poder añadirle prioridad a los tickets que los humanos crean, para
que en un futuro si está en modo autónomo y no hay nada corriendo pueda agarrar de los
tickets y ponerse a desarrollar."*

- Add a **priority** field to tickets (e.g. low/normal/high/urgent). Humans set it on
  manual tickets.
- **Autonomous self-tasking loop:** when the system is in autonomous mode AND idle (no
  run executing), it **pulls the highest-priority open ticket** (status todo/backlog,
  source manual or from analysis agents) and starts a dev run for it — then moves the
  ticket through in_progress→done as the run progresses.
- This closes the loop: the board becomes the **work queue** that feeds the agents, not
  just a status mirror. Connects to: the dead `TaskQueue` (Phase C concurrency), the
  agent router (§1), and the auto-ticket lifecycle already built (`run-tickets.ts`).
- **Near-term piece (do now):** the priority field itself. The self-tasking loop is a
  later phase (needs idle detection + safe guardrails so it doesn't burn budget).

## 5. Analysis agents that FILE tickets (QA, Security, Product Owner)

**User's words:** *"que exista un bot de QA y que también ponga tickets, uno que esté
haciendo análisis de seguridad informática en el proyecto y que también ponga tickets,
o un agente product owner que esté buscando la manera de mejorar el proyecto de manera
continua basado en análisis... reviews de los clientes, etc."*

New agents whose OUTPUT is tickets on the board (not direct code changes):
- **QA agent** — exercises the app / reviews diffs, files tickets for bugs found.
- **Security agent** — runs infosec analysis on the project, files tickets for
  vulnerabilities (extends the existing `security-scan` gate into a proactive agent).
- **Product Owner agent** — continuously proposes improvements, synthesizing inputs
  from the Market Research agent (§1), a Competition-analysis agent, customer reviews,
  etc., and files prioritized tickets for what to build next.

**Architecture implication:** these are "analysis → ticket" agents. They all WRITE to
the ticket store (source could become `qa`/`security`/`po` beyond auto/manual). Combined
with §4's self-tasking loop, this is the **flywheel**: analysis agents file prioritized
tickets → idle autonomous mode picks them up → dev builds them → QA/security review →
file more tickets. A genuinely self-improving project loop. Needs: ticket `source` enum
extended, each agent built (on the registry+router from §1), and guardrails.

## 6. Channel separation (user, 2026-06-16) — NEAR-TERM, doing now

The single `#unity-agent` channel is too noisy (runs + approvals + ticket updates all
mixed). Split into dedicated channels:
- **dev/runs** (existing `#unity-agent`) — autonomous run progress.
- **tickets** — ticket lifecycle notifications (→done, →blocked, new manual).
- **approvals** — marketing/agent authorization requests (✅/🗑️ buttons).

Config-driven via env (like the existing channel names), with fallback to the autonomous
channel if a dedicated one isn't configured (so nothing breaks if the channels don't
exist yet).

---

## How this maps onto the current roadmap

| Vision item | Lands in |
|---|---|
| Approval gateway (gate public actions) | ✅ Phase A Step 6 (done) |
| Manual agent selection (panel/Discord) | ✅ partial — marketing trigger (/marketing + panel) done |
| Traceability | ✅ Phase B — **in-house mini-Jira board** (NOT Slack/Jira; see [[inhouse-tickets]]) |
| **Channel separation (tickets / approvals / runs)** | **Near-term — doing NOW (§6)** |
| **Ticket priority field** | **Near-term — doing NOW (§4)** |
| Concurrency (many agents/runs at once) | Phase C |
| Agent Registry + intelligent router (PM dispatches by prompt) | NEXT major phase (§1) — evolve the PM stub |
| Market Research / Sales agents | On demand, once the registry+router exist (§1) |
| Autonomous self-tasking (idle → pull top-priority ticket → build) | Later phase (§4) — needs idle detection + guardrails + Phase C |
| Analysis agents that file tickets (QA / Security / PO) | Later phase (§5) — the self-improving flywheel |
| Project-as-memory repos (`.agent/` folders) | NEW phase — design the convention first (§2) |
| Automation flows | NEW phase — depends on router + memory repos (§3) |

**Sequencing principle (unchanged):** ship each as a working increment; don't build
the router before there are 3+ agents worth routing between; don't build memory-repo
conventions before an agent needs to read/write non-code context. The marketing
trigger being built now is the first taste of "talk to a specific agent."
