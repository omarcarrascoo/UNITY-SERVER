# Deep Deep Deep Repository Documentation

Generated from direct code analysis of this repository on 2026-04-29.

This document explains what `brain-station` does, how the server is put together, what each module is for, how the AI agents are configured, where they are called in the flow, and which parts are fully wired today versus present as forward-looking infrastructure.

## 1. Executive Summary

`brain-station` is the server/control plane for Unity Agent, also called Jarvis in parts of the code. It is not the application being edited. It is the orchestrator that receives work requests, prepares local Git workspaces for target repositories, asks LLM agents to inspect and change code, validates the result, persists state, and exposes human control surfaces through Discord and a local HTTP console.

The server supports two primary operating modes:

1. Manual development from Discord.
   A user writes a prompt in the manual channel. The system prepares a workspace, gathers repository context, runs the code-generation agent, validates TypeScript, starts a preview when possible, captures a screenshot, and lets the user approve a PR or revert.

2. Autonomous development from Discord or the local console.
   A user writes a bigger goal in the autonomous channel. The system creates a structured plan, persists it, waits for approval, executes scoped tasks in separate Git worktrees, validates each task with gates, reviews each task with an LLM reviewer, cherry-picks approved commits into an integration branch, and closes the run with artifacts and summaries.

The architectural center of the repo is this loop:

```text
Prompt
  -> workspace prep
  -> context gathering
  -> planning or direct execution
  -> specialized LLM role calls
  -> tool usage and code edits
  -> static/runtime gates
  -> review
  -> Git integration
  -> persistent artifacts and console visibility
```

The current runtime is a TypeScript ESM Node server. It uses Discord as the main user interface, Git/GitHub as the code transport, DeepSeek as the active LLM provider, SQLite as local state, and Puppeteer/runtime gates for UI verification.

## 2. What This Repository Is

This repo is a development orchestration server. Its job is to coordinate work against other repositories under `workspaces/`.

It owns:

- Discord handlers for prompts, buttons, and slash commands.
- A local HTTP console for plan approval, run inspection, analytics, knowledge, learning, and settings.
- Workspace preparation for target GitHub repos.
- A role-based LLM system over DeepSeek.
- A code-generation loop with tools, JSON patches, patch rollback, compiler validation, and loop-control heuristics.
- Autonomous task planning, execution, gate evaluation, review, retries, and integration.
- SQLite-backed persistence for runs, plans, tasks, events, artifacts, policies, memories, telemetry, learning patterns, and knowledge graph data.

It does not own:

- The final user app being modified.
- The target repo source, except local clones inside `workspaces/`.
- A production web deployment flow.
- A complete test suite for this server. The root `package.json` still has the placeholder `npm test` script.

## 3. Runtime Entry Point

### `index.ts`

This is the server boot file.

It performs four actions:

1. Loads environment variables through `dotenv/config`.
2. Reads runtime configuration with `getRuntimeConfig()`.
3. Creates a shared `RuntimeState`.
4. Starts the Discord client and the local HTTP console.

Important objects created here:

```ts
const config = getRuntimeConfig();
const runtime = new RuntimeState();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
```

Then:

```ts
registerDiscordHandlers(client, runtime);
startUnityHttpServer(runtime);
client.login(config.discordToken);
```

So the process is one shared runtime with two transports:

- Discord: conversational input and controls.
- HTTP: local observability and approval console.

The debug log at startup prints current working directory, workspace directory, configured GitHub repo, and active target repo path.

## 4. Configuration

### `src/config.ts`

This file centralizes all environment-driven runtime configuration.

Computed paths:

- `PROJECT_ROOT`: repository root.
- `WORKSPACE_DIR`: root `workspaces/` directory where target repos are cloned.
- `DATA_DIR`: root `.unity/` directory where SQLite files and local agent state live.

Required environment variables:

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_TOKEN`
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`

Operationally required for AI work:

- `DEEPSEEK_API_KEY`

Optional variables:

- `GITHUB_BASE_BRANCH`, default `main`
- `FIGMA_TOKEN`
- `UNITY_MANUAL_CHANNEL`, default `jarvis-dev`
- `UNITY_AUTONOMOUS_CHANNEL`, default `unity-agent`
- `UNITY_INTEGRATION_BRANCH`, default in code `unity-per2323455632`
- `UNITY_LOCAL_CONSOLE_PORT`, default `4477`

Important nuance:

`deepseekApiKey` is optional in the `RuntimeConfig` type, but the actual provider registry requires `DEEPSEEK_API_KEY` for all active LLM roles. Without it, `resolveProvider()` eventually throws because no provider is available.

Another nuance:

`.env.example` says:

```text
UNITY_INTEGRATION_BRANCH=unity-per-development
```

but `src/config.ts` falls back to:

```text
unity-per2323455632
```

So this value should be set explicitly in `.env` to avoid confusion.

## 5. Project Structure

High-level layout:

```text
.
|-- index.ts
|-- src/
|   |-- application/
|   |-- domain/
|   |-- runtime/
|   |-- services/
|   |   |-- ai/
|   |   |-- knowledge/
|   |   |-- learning/
|   |   |-- orchestration/
|   |   |-- persistence/
|   |   `-- telemetry/
|   |-- shared/
|   |-- transports/
|   |   |-- discord/
|   |   |-- http/
|   |   `-- webhooks/
|   |-- ai.ts
|   |-- ai-monolitich.ts
|   |-- config.ts
|   |-- figma.ts
|   |-- git.ts
|   |-- scanner.ts
|   |-- snapshot.ts
|   |-- templates.ts
|   `-- tools.ts
|-- planning-docs/
|-- utils/
|-- workspaces/
`-- .unity/
```

The most important conceptual split:

- `application/`: user-level workflows.
- `services/ai/`: model routing, agents, tools, prompts, edits, validation.
- `services/orchestration/`: autonomous execution mechanics.
- `transports/`: Discord, HTTP, webhooks.
- `services/persistence/`, `learning/`, `knowledge/`, `telemetry/`: local memory and observability.
- `runtime/`: live in-memory coordination.
- `domain/`: shared TypeScript types.

## 6. Domain Types

### `src/domain/runtime.ts`

This file defines the manual-workflow runtime shapes.

Key types:

- `WorkspaceProject`: target repo identity and paths.
- `PreparedWorkspace`: target repo plus detected Expo path, API path, and package directories.
- `ProjectContextSnapshot`: Figma context, project tree, `.unityrc` memory, and current diff.
- `TaskExecutionResult`: AI output for manual code generation.
- `CompletedTaskArtifacts`: manual run artifacts returned to Discord, including snapshot path, local URL, public URL, warning, and diff path.

Purpose:

These types describe the "single request against one repo" path. They are intentionally smaller than autonomous orchestration types.

### `src/domain/orchestration.ts`

This file defines autonomous-run vocabulary.

Important types:

- `AgentRole`: orchestration-level labels such as `planner`, `executor`, `reviewer`, `explorer`, `architect`.
- `RunStatus`: lifecycle states such as `planning`, `awaiting_plan_approval`, `running`, `healing`, `completed`, `failed`, `cancelled`.
- `RunMode`: `interactive`, `nightly`, or `auto`.
- `PlanRecord`: persisted plan plus approval/rejection metadata.
- `TaskRecord`: persisted autonomous task, including write scope, dependencies, branch, worktree path, commit SHA, attempts, and validation summary.
- `PlanTaskDraft`: planner output shape for an executable task.
- `ReviewResult`: reviewer output with findings and follow-up tasks.
- `GateResult`: normalized static/runtime gate result.
- `ArtifactRecord` and `RunEventRecord`: observability records.

Purpose:

This file is the schema contract between planning, storage, console rendering, and autonomous execution.

### `src/domain/policies.ts`

This file defines policy and gate controls.

`GatePolicy` controls:

- `runTypecheck`
- `runLint`
- `runTests`
- `runBuild`
- `runRuntime`
- `requireRuntimeForUi`
- `captureSnapshot`
- `runSecurityScan`
- `runImportCycleCheck`

`AutonomousRunPolicy` controls:

- integration branch
- plan auto-approval
- parallelism
- retries
- improvement cycles
- max hours
- max commits
- token budgets
- per-task minute budget
- gates

Purpose:

The policy layer lets the system adapt from cautious human-approved work to more aggressive unattended runs.

## 7. Runtime State

### `src/runtime/state.ts`

`RuntimeState` is the in-memory coordination object shared by Discord and HTTP.

It stores:

- Current active project name.
- Manual session records by session ID.
- Active runs by runtime ID.
- A `TaskQueue` instance.

Important methods:

- `getActiveProject()`
- `setActiveProject(repoName)`
- `isProcessing()`
- `startProcessing(runId?, projectName?)`
- `finishProcessing(runId?)`
- `abortCurrentTask(runId?)`
- `abortByProject(projectName)`
- `rememberSession(sessionId, commitMessage, projectName)`

Why it exists:

The transports need a shared way to answer "what repo are we working on?", "is something already running?", and "what should this approve/reject button apply to?"

Current wiring detail:

The class supports multiple active runs and has a queue, but the main Discord/HTTP call sites often call `startProcessing()` without the real autonomous run ID, which creates a `legacy-*` active run ID. That preserves backward compatibility, but it means some run-specific cancellation features are not fully used by the current transports.

### `src/runtime/task-queue.ts`

`TaskQueue` is a generic priority queue with:

- `critical`, `normal`, `low` priorities.
- Configurable max concurrency.
- Per-task timeout using `AbortController`.
- Cancellation by task ID.
- Cancellation by project.
- Drain behavior.
- Metrics for pending/running tasks.

Why it exists:

It is infrastructure for backpressure and safer multi-run scheduling.

Current wiring detail:

`RuntimeState` creates `new TaskQueue(6)`, and metrics are shown in `/status`, but the main autonomous execution loop currently schedules task batches directly with `Promise.all()`. So the queue exists, but it is not yet the main execution scheduler.

### `src/runtime/services.ts`

Exports the singleton:

```ts
export const unityStore = new UnityStore();
```

Why it exists:

It gives application and transport code a shared persistent store without recreating SQLite connections everywhere.

## 8. Workspace And Git Layer

### `src/git.ts`

This file owns target-repository workspace operations for manual flows and project setup.

Important functions:

- `resolveWorkspace(project)`: inspect an existing local repo and return detected targets.
- `prepareWorkspace(project)`: clone or reset/pull target repo, then install dependencies.
- `getRepositoryStatus(project)`: `git status --porcelain`.
- `getRepositoryDiff(project)`: current `git diff`.
- `resetWorkspace(project)`: hard reset and clean local workspace.
- `createPullRequest(workspace, featureName, commitMessage)`: create branch, commit, push, then call GitHub REST API.
- `scaffoldProject(type, name, workspaceDir)`: create Expo, Nest, or fullstack starter.

Workspace detection:

`scanWorkspaceTargets()` looks for:

- root Expo app if root `package.json` has `expo`.
- child package directories in monorepos.
- Expo package by dependency or directory name.
- Nest/API package by `@nestjs/core`, `api`, or `infra`.

Dependency installation:

- Single repo: run `npm install` at root.
- Monorepo: run `npm install` in each detected package directory.

Why it exists:

The AI agent should operate against a real, dependency-installed repo. This layer makes target repos reproducible local workspaces.

### `src/scanner.ts`

This file provides lightweight repo context for prompts.

Functions:

- `getProjectTree(dirPath, prefix, currentDepth, maxDepth)`: shallow tree, default max depth 2.
- `getProjectMemory(repoPath)`: reads `.unityrc.md`, `unityrc.md`, or text variants.

Why it exists:

The prompt needs a compact map of the target repo and project-specific rules without dumping the whole repo into context.

Important behavior:

The tree ignores heavy or noisy paths such as `node_modules`, `.git`, `assets`, `dist`, `.expo`, `ios`, `android`, scripts, `.github`, and common lock/config files.

### `src/snapshot.ts`

This file is used by the manual Discord flow to launch a preview and capture a mobile screenshot.

Flow:

1. Normalize Expo route from the AI `targetRoute`.
2. Kill any tracked Expo/Nest processes.
3. Clear ports `8081` and `3000`.
4. If an API path exists, start `npm run start` in the API package.
5. Inject `EXPO_PUBLIC_API_URL` into the Expo `.env`.
6. Start Expo web with `npx expo start --web --port 8081`.
7. Wait for a ready signal.
8. Use Puppeteer with a 390 x 844 mobile viewport.
9. Save `snapshot.png` in the workspace root.

Why it exists:

The manual loop needs a visual artifact the user can inspect in Discord before approving a PR.

Portability note:

The port cleanup uses `fuser -k`. On systems without `fuser`, cleanup may fail harmlessly, but stale port listeners can affect previews.

### `src/figma.ts`

This file extracts Figma node context from prompts.

It:

- Detects Figma file/design URLs with `node-id`.
- Downloads the node through the Figma API.
- Reduces the payload to layout, text, fill, stroke, typography, spacing, padding, and children.
- Caches node payloads by node ID.

Why it exists:

The AI agent can reconstruct UI from design context without receiving the full Figma document.

## 9. Application Workflows

### `src/application/run-development-task.ts`

This is the manual Discord development workflow.

Sequence:

```text
manual Discord message
  -> prepareWorkspace() or resolveWorkspace()
  -> getFigmaContext()
  -> getProjectTree()
  -> getProjectMemory()
  -> optional current diff for iteration
  -> generateAndWriteCode()
  -> takeSnapshot()
  -> archive diff artifacts
  -> persist changes_<session>.diff
  -> return CompletedTaskArtifacts
```

Fresh task versus iteration:

- Fresh task calls `prepareWorkspace()`, which resets/pulls the target repo.
- Iteration calls `resolveWorkspace()` and includes current uncommitted diff as short-term memory.

Why it exists:

This is the quick pairing loop. It favors speed, screenshot feedback, and a simple approve/revert decision.

### `src/application/approve-session.ts`

This turns a manual session into a GitHub PR.

Sequence:

1. Resolve workspace.
2. Read final diff.
3. If diff exists, call `generatePRMetadata(diff)`.
4. Otherwise use stored/fallback commit message.
5. Call `createPullRequest()`.

AI role used:

- `pr-metadata`

Why it exists:

The code-generation agent often returns a short commit message. This module asks a dedicated metadata role to summarize the actual final diff for the commit and PR.

### `src/application/reject-session.ts`

This simply calls `resetWorkspace(project)`.

Why it exists:

Manual sessions leave uncommitted files in the target workspace until the user approves or rejects. Rejection should clean the repo.

### `src/application/projects/init-project.ts`

This delegates to `scaffoldProject()`.

Why it exists:

Discord `/init` can create starter projects under `workspaces/`.

### `src/application/run-autonomous-agent.ts`

This is the deepest and most important file in the repo. It implements the autonomous run lifecycle.

It contains:

- Run creation.
- Plan generation and persistence.
- Plan approval/rejection functions.
- Resume/checkpoint recovery.
- Worktree task execution.
- Batch scheduling.
- Scope enforcement.
- Baseline-delta comparison.
- Review.
- Retry.
- Integration.
- Improvement cycles.
- Final gates.
- Run closure assessment.
- Knowledge graph update.
- Continuous improvement memory persistence.

#### Autonomous Planning Flow

Function:

```ts
createAutonomousRunPlan()
```

Sequence:

```text
request
  -> get project policy
  -> prepare workspace
  -> scan knowledge graph on first project use
  -> ensure integration branch
  -> run baseline static gates
  -> create RunRecord
  -> persist run and baseline gate artifact
  -> read project tree and project memory
  -> persist run_context memory
  -> planAutonomousRun()
  -> persist plan and plan artifact
  -> set run to awaiting_plan_approval or running
```

Auto-approval detail:

```ts
function shouldAutoApprovePlan(mode, policy) {
  return mode === 'nightly' && policy.autoApprovePlan;
}
```

So only `nightly` mode auto-approves. `interactive` waits for local console approval. `auto` mode currently does not auto-approve even when the policy has `autoApprovePlan: true`.

#### Plan Approval And Resume

Functions:

- `approveAutonomousRunPlan(runId, approvedBy)`
- `rejectAutonomousRunPlan(runId, rejectedBy, rejectedReason)`
- `resumeAutonomousRun({ runId })`

`resumeAutonomousRun()`:

1. Loads run and latest plan.
2. Requires plan status `approved`.
3. Prepares workspace.
4. Ensures integration branch.
5. Loads or recomputes baseline static gates.
6. If run status was `running` or `healing`, resets interrupted `running` tasks to `pending`.
7. Marks run `running`.
8. Calls `executeApprovedRun()`.

Why resume exists:

The system persists plans/tasks/events, so a crashed process can continue a run instead of starting over.

#### Task Execution Flow

Function:

```ts
executeTask()
```

Sequence:

```text
task
  -> create git worktree from integration branch
  -> mark task running
  -> run baseline scoped static gates
  -> read project tree for worktree
  -> build learning context
  -> run Explorer -> Architect pipeline
  -> build baseline failure context
  -> generateAndWriteCode()
  -> commit worktree changes
  -> read task diff
  -> check write scope
  -> run scoped static gates again
  -> compare against baseline gates
  -> reviewTaskResult()
  -> record pattern outcomes
  -> extract new learned pattern on success
  -> remove task worktree
```

Important validation concepts:

- Scope gate: rejects a task if its diff touches paths outside `writeScope`.
- Baseline-delta gate: rejects a task if it introduces new scoped gate failures that were not already present before the task.
- Reviewer: adds narrative findings and follow-up tasks, but approval is governed by deterministic gates.

#### Batch Scheduling

Function:

```ts
selectRunnableBatch(tasks, maxParallelTasks)
```

It selects pending tasks whose dependencies have succeeded and whose write scopes do not conflict.

Scope conflict logic:

- `.` conflicts with everything.
- identical paths conflict.
- parent/child path scopes conflict.

Why it exists:

The system tries to parallelize independent work while avoiding two tasks editing the same file family at the same time.

#### Integration

Function:

```ts
integrateTaskResult()
```

Sequence:

1. Checkout integration branch.
2. Cherry-pick task commit.
3. If cherry-pick conflicts, `branch-manager.ts` attempts auto-resolution.
4. Push integration branch.
5. If push fails, reset `HEAD~1` to restore clean integration branch and throw.

Why it exists:

Each task works in isolation. Integration is the controlled merge point where isolated task commits become part of the run branch.

#### Improvement Cycles

The reviewer can return `followUpTasks`. `executeApprovedRun()` collects them and can create improvement tasks when:

- there are no runnable required tasks left,
- the run is not in the closing window,
- `improvementCycle < policy.maxImprovementCycles`,
- `commitsCreated < policy.maxCommits`.

Improvement tasks are titled:

```text
[Improvement N] <original follow-up title>
```

Why it exists:

The system can self-heal or polish after primary tasks finish, but only within policy budgets.

#### Closing Window

The constant:

```ts
RUN_CLOSING_WINDOW_MS = 10 * 60 * 1000
```

When the run has 10 minutes or less left, it enters a graceful drain mode:

- stop opening new improvement cycles,
- focus on wrapping up,
- block remaining pending tasks if needed.

Why it exists:

Autonomous runs should produce a coherent ending rather than starting new work near the deadline.

#### Final Closure

After task loop:

1. Checkout integration branch.
2. Run final static gates.
3. Run runtime gate.
4. Assess closure:
   - required tasks complete?
   - new static failures?
   - runtime failures?
   - budget warnings?
   - incomplete follow-ups?
5. Persist continuous improvement memory.
6. Persist `run-close-report` artifact.
7. Update knowledge graph.
8. Mark run `completed`, `completed_with_warnings`, or `failed`.

Why it exists:

The run needs a durable final state that the console, future memory, and the user can inspect.

## 10. AI Architecture

The active AI stack lives in `src/services/ai/`.

The system has three layers:

```text
Call site
  -> roleCompletion(role, request)
  -> model-router chooses ModelConfig
  -> provider-registry resolves provider
  -> DeepSeekProvider builds request
  -> client.ts sends OpenAI-compatible API call with retry
```

### `src/services/ai/model-router.ts`

This file maps logical agent roles to model settings.

All current roles use:

```text
model: deepseek-v4-pro
provider: deepseek
```

Role table:

| Role | Model | Tier | Thinking | Reasoning effort | Temperature | Max output tokens | Main call sites |
| --- | --- | --- | --- | --- | --- | ---: | --- |
| `code-gen` | `deepseek-v4-pro` | reasoning | enabled | max | 0.2 | 120000 | `generateAndWriteCode()` in manual and autonomous executor |
| `planning` | `deepseek-v4-pro` | reasoning | enabled by default | high | 0.4 | 120000 | `planAutonomousRun()`, `planMultiRepoRun()` |
| `explorer` | `deepseek-v4-pro` | reasoning | enabled | high | 0.2 | 120000 | `runExplorerAgent()` before autonomous implementation |
| `architect` | `deepseek-v4-pro` | reasoning | enabled | max | 0.3 | 120000 | `runArchitectAgent()` after explorer |
| `review` | `deepseek-v4-pro` | chat | disabled | none | 0 | 30000 | `reviewTaskResult()` after task gates |
| `repair` | `deepseek-v4-pro` | chat | disabled | none | 0 | 25000 | JSON repair and learning summary |
| `pr-metadata` | `deepseek-v4-pro` | chat | disabled | none | 0.4 | 10000 | `generatePRMetadata()` during manual PR approval |

Important DeepSeek behavior:

When `thinking` is enabled, `DeepSeekProvider` omits temperature from the payload. The comments say temperature and sampling penalties are ignored by the provider in thinking mode. So for `code-gen`, `planning`, `explorer`, and `architect`, the configured temperature is documentation/default metadata, but not actually sent while thinking is enabled.

Why these settings make sense:

- `code-gen`: needs maximum reasoning and a very large output budget because it receives repo context, may use tools over many turns, and must produce structured edits after reasoning through implementation and validation errors.
- `planning`: needs strong reasoning to split a user request into safe, parallelizable tasks with correct write scopes. It uses high rather than max because planning is structured decomposition, not final implementation.
- `explorer`: needs high reasoning and long context because it reads files, searches patterns, and produces a structured report.
- `architect`: gets the explorer report and designs exact implementation. It uses max reasoning because its output directly guides the implementer.
- `review`: uses deterministic chat settings. It should not be creative about approval, and gates override the approval field anyway.
- `repair`: uses deterministic chat settings because it normalizes malformed JSON or summarizes a pattern. Low randomness protects schema stability.
- `pr-metadata`: uses chat mode with moderate temperature because commit summaries can be slightly expressive, but the task is bounded by the diff and has a 10000 token cap.

### `src/services/ai/completion.ts`

This is the unified completion entry point:

```ts
roleCompletion(role, request)
```

It:

1. Gets model config from `model-router`.
2. Resolves provider from `provider-registry`.
3. Builds a normalized `LLMCompletionRequest`.
4. Sends it to the provider.
5. Records token usage if `runId` is supplied.
6. Throws if token budget is exceeded.

Current budget wiring detail:

`roleCompletion()` records tokens with `getTokenTracker()`, but no main flow currently initializes the tracker with the policy values from `AutonomousRunPolicy`. The default tracker budget is unlimited (`maxTokensPerRun: 0`, `maxTokensPerTask: 0`). So token usage is tracked in memory, but policy limits are not fully enforced unless something initializes the global tracker with a budget.

### `src/services/ai/providers/types.ts`

Defines provider-independent types:

- `LLMMessage`
- `LLMToolCall`
- `LLMToolDefinition`
- `ReasoningEffort`
- `LLMCompletionRequest`
- `LLMCompletionResponse`
- `LLMProvider`

Important field:

```ts
reasoning_content?: string
```

DeepSeek thinking mode requires reasoning content to be echoed back in later messages when preserving assistant turns. The code-generation loop is careful about this.

### `src/services/ai/providers/deepseek-provider.ts`

This wraps DeepSeek through the OpenAI SDK-compatible API.

Payload behavior:

- Always sends `model`, `messages`, and `max_tokens`.
- Sends `temperature` only when thinking is disabled.
- Sends `tools` if provided.
- Sends `response_format` if requested.
- Sends:

```ts
thinking: { type: 'enabled' }
reasoning_effort: <effort>
```

when thinking is enabled, otherwise:

```ts
thinking: { type: 'disabled' }
```

It returns normalized:

- `content`
- `toolCalls`
- `reasoningContent`
- token usage
- raw response

Why it exists:

The rest of the app should not depend on the OpenAI SDK response shape or DeepSeek-specific thinking payloads.

### `src/services/ai/providers/provider-registry.ts`

Currently registers only DeepSeek by default.

It supports:

- registering additional providers,
- fallback order,
- resolving requested provider,
- listing availability.

Why it exists:

The repo has older code for Gemini, Anthropic, Groq, and OpenRouter, but the active system uses a provider abstraction so those could be reintroduced cleanly.

### `src/services/ai/client.ts`

This is the low-level DeepSeek client.

Settings:

- `baseURL`: `https://api.deepseek.com`
- `timeout`: 120000 ms
- OpenAI SDK `maxRetries`: 0
- custom network retry loop: 3 attempts
- retry backoff: `750 * attempt` ms

Retryable errors include:

- HTTP 408, 409, 429, 500, 502, 503, 504
- `ECONNRESET`
- `ETIMEDOUT`
- `ECONNABORTED`
- `EPIPE`
- `UND_ERR_CONNECT_TIMEOUT`
- messages containing timeout/network/terminated/reset

Debugging:

If `DEEPSEEK_DEBUG=1`, 400 responses print a summarized payload, especially the last assistant message with tool calls and reasoning content.

Why it exists:

LLM calls are network-sensitive. This wrapper keeps provider retries predictable and makes DeepSeek reasoning/tool-call errors diagnosable.

## 11. The Code Generation Agent

### `src/services/ai/agent-runner.ts`

Function:

```ts
generateAndWriteCode()
```

This is the implementer/code-generation loop used by:

- manual flow in `run-development-task.ts`,
- autonomous task execution in `run-autonomous-agent.ts`.

Inputs:

- `repoPath`
- `userPrompt`
- `figmaData`
- `projectTree`
- `projectMemory`
- `currentDiff`
- `learnedPatterns`
- `architectContext`
- abort signal
- run/task IDs for token tracking
- status callback

Agent setup:

- Builds tool runtime with `createAgentToolRuntime(repoPath)`.
- Builds system prompt with `buildSystemPrompt()`.
- Starts messages with system and user messages.
- Uses `roleCompletion('code-gen')`.
- Allows up to 100 loop iterations.

Loop behavior:

```text
for loop 1..100:
  -> call code-gen role
  -> if tool calls:
       record tool history
       evaluate loop-control heuristics
       maybe redirect toward implementation
       execute tools
       append tool results
       continue
  -> if no tool calls:
       parse final JSON
       baseline typecheck
       apply edits atomically
       typecheck again
       compare new errors
       self-correct if needed
       accept final result
```

Final JSON expected from model:

```json
{
  "targetRoute": "/path",
  "commitMessage": "feat: summary",
  "edits": [
    {
      "filepath": "relative/path.ts",
      "search": "exact code to replace",
      "replace": "new code"
    }
  ]
}
```

Important self-correction paths:

- Invalid JSON -> asks model to return exactly one JSON object.
- Patch error -> tells model search block did not apply.
- TypeScript errors with no baseline errors -> asks model to repair introduced errors.
- TypeScript errors with baseline errors -> compares normalized error lines and only rejects new errors.
- `edits: []` with unexpected diff -> asks model to correct final JSON unless changes were already written by a mid-loop file-writing tool. The prompt mentions `write_file`/`apply_diff`, while the current exported tool list exposes `write_file`.

Reasoning content detail:

The code pushes `reasoning_content` back into conversation history whenever the provider returns it. Comments explain DeepSeek needs that string preserved on thinking-mode turns.

Loop control:

- Tracks tool history such as `read_file:path`.
- Detects spirals and stale exploration.
- After 3 consecutive redirects, disables tools and forces JSON-only response.
- Emits `telemetry.redirectSpiral()` after repeated redirects.

Return value:

- `targetRoute`
- `commitMessage`
- `tokenUsage`
- `iterations`
- `toolHistory`
- `filesRead`

Why it exists:

This is the main "write code safely" mechanism. It combines model reasoning, repo tools, patch application, and compiler checks so the server does not blindly trust a model response.

### `src/services/ai/prompt-builder.ts`

Builds the code-generation system prompt.

Prompt sections:

- Project tree.
- Default repository patterns.
- Figma JSON context.
- Strict project memory from `.unityrc.md`.
- Uncommitted diff for manual iteration.
- Learned patterns from prior successful runs.
- Explorer/Architect pre-analysis.
- Baseline failures that should not be fixed.
- User objective.
- Cognitive execution rules.
- Tool usage contract.
- Final output contract.

Why it exists:

The implementer needs strong behavioral constraints: minimal scope, no unrelated cleanup, use tools carefully, return exact JSON, and preserve current session changes.

### `src/services/ai/edit-operations.ts`

This file parses model JSON and applies edits.

Features:

- Extract JSON from raw model output.
- Repair common JSON issues.
- Safe path resolution to block paths outside repo.
- No-op edit rejection when `search === replace`.
- Line-range edit mode if `startLine`/`endLine` appear.
- New file/full replacement when file does not exist or search is empty.
- Exact search/replace.
- Ambiguity detection if search appears more than once.
- Fuzzy matching fallback with whitespace normalization and line-based similarity threshold 0.85.
- Atomic rollback: snapshots all touched files and restores them if any edit fails.

Why it exists:

Model-generated search blocks are often imperfect. This layer makes patching safer and gives the model useful correction messages.

### `src/services/ai/validation-service.ts`

Runs TypeScript validation for edited top-level directories.

Functions:

- `runTypecheckForDirs(repoPath, dirs)`
- `getNewCompilationErrors(baseline, current)`
- `getCurrentGitDiff(repoPath)`

Behavior:

- For each directory, only runs `npx tsc --noEmit` if that directory has `tsconfig.json`.
- Normalizes compiler output so old errors can be compared against current errors.

Why it exists:

The code-generation loop should accept changes when the repo already had unrelated TypeScript errors, but reject changes that add new errors.

### `src/services/ai/loop-heuristics.ts`

This file prevents tool-use loops.

Signals:

- Spiral pattern: last three tool calls repeat the previous three, or same call happens 4+ times.
- Information gain: recent tool calls are high/low/stale based on whether they discover new entries.
- Broad exploration count: generic searches/listing.
- Target evidence: at least 2 unique files read, at least 1 search, combined score >= 4.
- Iteration pressure: redirect at 15 iterations with enough evidence, hard warning at 25.

Why it exists:

LLM agents can get stuck searching forever. This module nudges or forces the agent to implement once it has enough evidence.

### `src/services/ai/pr-metadata.ts`

Uses role `pr-metadata` to turn a final diff into a conventional commit message with a brief bullet summary.

Input diff is truncated to 6000 characters.

Why it exists:

PR metadata should reflect actual changes, not only the original prompt.

### `src/ai.ts`

Small public re-export:

- `generateAndWriteCode`
- `generatePRMetadata`

Why it exists:

Application modules import from `../ai.js` rather than knowing internal AI service paths.

### `src/ai-monolitich.ts`

Legacy one-shot generator.

It supports:

- Gemini `gemini-2.5-flash`
- Anthropic `claude-sonnet-4-5-20250929`, `max_tokens: 8192`, `temperature: 0.1`
- DeepSeek `deepseek-v4-pro`, `max_tokens: 8192`, `temperature: 0.1`
- Groq `llama-3.3-70b-versatile`
- OpenRouter `qwen/qwen-2.5-coder-32b-instruct:free`

It asks for full file outputs:

```json
{
  "targetRoute": "/path-to-test",
  "commitMessage": "feat: ...",
  "files": [
    { "filepath": "app/(tabs)/index.tsx", "code": "full code..." }
  ]
}
```

Current role:

The active `src/ai.ts` does not export this legacy implementation. It remains as historical or fallback code.

## 12. Multi-Agent Specialization

### `src/services/ai/agent-roles.ts`

This file splits autonomous task preparation into:

```text
Explorer -> Architect -> Implementer
```

The implementer is still `generateAndWriteCode()`. This file only runs Explorer and Architect and returns context for the implementer.

#### Explorer Agent

Role:

- `explorer`

Model settings:

- model: `deepseek-v4-pro`
- max tokens: 120000
- thinking: enabled
- reasoning effort: high
- temperature: 0.2 but omitted while thinking is enabled

Tools allowed:

- `read_file`
- `grep_code`
- `search_project`
- `list_directory`
- `find_references`
- `run_command`

Expected output:

```json
{
  "entryPoints": ["file1.ts"],
  "patterns": "Description",
  "dependencies": ["module1"],
  "risks": "Risks",
  "approach": "Recommended approach",
  "keySnippets": {
    "file.ts": "relevant snippet"
  }
}
```

Where it runs:

`executeTask()` calls `runAgentPipeline()` before `generateAndWriteCode()` in autonomous runs.

Why these settings:

Explorer needs enough reasoning to map code structure and enough output budget to return a useful report. It is read-oriented, so high reasoning is enough; max effort is saved for code generation and architecture.

Current nuance:

The Explorer prompt says read-only. The filtered tools include `run_command`, and the shared `run_command` allowlist permits some dependency commands such as `npm install`. The prompt constrains behavior, but the tool layer is broader than purely read-only.

#### Architect Agent

Role:

- `architect`

Model settings:

- model: `deepseek-v4-pro`
- max tokens: 120000
- thinking: enabled
- reasoning effort: max
- temperature: 0.3 but omitted while thinking is enabled

Tools:

- none

Expected output:

```json
{
  "plan": "Step-by-step implementation plan",
  "fileChanges": [
    {
      "file": "path/to/file.ts",
      "action": "create",
      "description": "What to change and why",
      "pattern": "Pattern to follow"
    }
  ],
  "testStrategy": "How to verify",
  "commitMessage": "Suggested commit message"
}
```

Where it runs:

Immediately after Explorer in `runAgentPipeline()`.

Why these settings:

Architect is the bridge between exploration and implementation. It must convert observations into a precise plan that reduces implementer wandering, so it receives max reasoning but does not need tools.

#### Implementer Agent

Role:

- `code-gen`

Model settings:

- model: `deepseek-v4-pro`
- max tokens: 120000
- thinking: enabled
- reasoning effort: max
- temperature: 0.2 but omitted while thinking is enabled

Tools:

The full `agentTools` list from `src/tools.ts`:

- `read_file`
- `grep_code`
- `search_project`
- `list_directory`
- `find_references`
- `run_command`
- `run_tests`
- `write_file`

Where it runs:

- manual flow: `runDevelopmentTask()`
- autonomous flow: `executeTask()`

Why these settings:

This is the highest-risk role because it changes code. It gets max reasoning, large output, tool access, validation feedback, learned patterns, and architect context.

#### Reviewer Agent

Role:

- `review`

Model settings:

- model: `deepseek-v4-pro`
- max tokens: 30000
- thinking: disabled
- temperature: 0

Tools:

- none

Where it runs:

After a task commit, scope gate, baseline-delta gate, and static gates in `executeTask()`.

Important behavior:

The reviewer is not authoritative for approval. The review prompt says deterministic gates decide approval and the system overrides `approved` with `shouldApproveFromGates()`.

Why these settings:

Review output should be deterministic, schema-stable, and concise. It should add narrative value and follow-up tasks, not invent policy.

#### Repair Agent

Role:

- `repair`

Model settings:

- model: `deepseek-v4-pro`
- max tokens: 25000
- thinking: disabled
- temperature: 0

Where it runs:

- `reviewer.ts` uses it to normalize malformed reviewer output.
- `pattern-extractor.ts` uses it to summarize successful task approaches, with a per-call `maxTokens: 200` override.

Why these settings:

Repair and normalization should be predictable and schema-preserving.

#### PR Metadata Agent

Role:

- `pr-metadata`

Model settings:

- model: `deepseek-v4-pro`
- max tokens: 10000
- thinking: disabled
- temperature: 0.4

Where it runs:

Manual session approval, inside `approveSession()`.

Why these settings:

Commit metadata benefits from natural-language summarization but should stay bounded and cheap compared with implementation roles.

## 13. Tool Runtime

### `src/tools.ts`

This file defines the tools the LLM agents can call.

Path safety:

All file paths are resolved relative to the target repo root. Paths outside the repo are rejected.

Ignored directories:

- `.git`
- `node_modules`
- `dist`
- `build`
- `coverage`
- `.expo`
- `ios`
- `android`
- `.next`

#### `read_file`

Reads a relative file with optional line range.

Default output:

- up to 500 lines,
- line numbers,
- total line count.

Purpose:

Targeted code inspection.

#### `grep_code`

Regex search with optional file glob, context lines, and max results.

Purpose:

Find implementations, exports, props, route handlers, or patterns quickly.

#### `search_project`

Keyword search across source-like files.

Purpose:

Backward-compatible simpler search when regex is not needed.

#### `list_directory`

Recursive directory tree with sizes, depth up to 6, optional glob.

Purpose:

Let Explorer understand local structure beyond the shallow initial `projectTree`.

#### `find_references`

Regex-based import/usage finder for a symbol.

Purpose:

Approximate code reference tracking without a TypeScript compiler index.

#### `run_command`

Runs safe commands only.

Allowed categories:

- `pwd`, `ls`, `cat`, `head`, `tail`, `sort`, `wc`, `grep`, `rg`, `sed -n`, safe `find`
- `git status`, `git diff`, `git log`
- `npm run lint/test/typecheck/build/start`
- `npx tsc`, `npx eslint`, `npx prettier`, `npx jest`, `npx vitest`
- selected Expo commands
- `npm install`, `npm uninstall`, `npm i`

Blocked shell features:

- parent traversal,
- absolute paths except `/dev` and `/tmp` patterns,
- `;`,
- `||`,
- redirection,
- background `&`,
- backticks,
- command substitution,
- unsafe shell operators.

Purpose:

Let the agent validate and inspect without arbitrary shell access.

#### `run_tests`

Runs Jest or Vitest with CI-like environment and longer timeout.

Purpose:

Targeted test execution.

#### `write_file`

Creates or overwrites a file mid-loop.

Purpose:

Useful for new files or full rewrites when search/replace is awkward.

Important final-output rule:

If the agent already wrote files with `write_file`, the prompt tells it to return `edits: []` in final JSON to avoid duplicate patching.

## 14. Planning And Review

### `src/services/orchestration/planner.ts`

Uses role:

- `planning`

Model settings:

- Primary: thinking enabled, high reasoning, max tokens 120000.
- Fallback: thinking disabled with JSON response format if primary returns empty or non-JSON.

Purpose:

Turn a user goal into independent, executable task drafts.

Planner rules:

- Break work into granular tasks when files/scopes are independent.
- Use concrete repo-root-relative `writeScope` paths.
- Include monorepo package prefix.
- Dependencies only when one task needs files introduced by another.
- Avoid analysis-only tasks.
- Each task prompt must be self-contained.

Normalization:

- Removes advisory tasks like "analyze" or "review" unless no executable tasks exist.
- Wraps each prompt with an execution contract.
- Defaults missing write scope to `.`.
- Filters dependencies to selected task titles.

Fallback:

If planning fails, it creates one broad task:

```text
Primary Implementation
writeScope: ["."]
```

Why it exists:

Autonomous execution only works if tasks are small, scoped, and dependency-aware.

### `src/services/orchestration/reviewer.ts`

Uses roles:

- `review`
- `repair` as fallback for malformed JSON

Purpose:

Review task diffs, summarize what changed, report findings, and optionally propose follow-up tasks.

Important design:

Approval is deterministic:

- `scope` failed -> reject.
- `baseline-delta` failed -> reject.
- otherwise approve.

The LLM's `approved` field is overwritten by the deterministic result.

Diff budget:

- Review diff is truncated to 24000 characters for prompt size.
- Prompt explicitly tells the reviewer not to reject due to truncation.

Fallback:

If review and repair both fail, `buildDeterministicFallbackReview()` creates a review from gates and changed files.

Why it exists:

The reviewer adds human-readable context and improvement ideas, while gates preserve deterministic safety.

## 15. Policies

### `src/services/orchestration/policy-engine.ts`

Default policy:

```text
integrationBranchName: from config
autoApprovePlan: true
maxParallelTasks: 3
maxRetriesPerTask: 2
maxImprovementCycles: 2
maxHours: 1
maxCommits: 8
maxTokensPerRun: 2000000
maxTokensPerTask: 500000
maxMinutesPerTask: 30
```

Default gates:

```text
runTypecheck: true
runLint: true
runTests: true
runBuild: true
runRuntime: true
requireRuntimeForUi: true
captureSnapshot: false
runSecurityScan: true
runImportCycleCheck: true
```

Normalization clamps:

- parallel tasks: 1 to 6
- retries: 0 to 5
- improvement cycles: 0 to 4
- hours: 1 to 4
- commits: 1 to 50
- minutes per task: 5 to 120

Presets:

- `conservative`: 1 parallel, 1 retry, 1 improvement, 1 hour, 4 commits, 1M/run, 250K/task, no auto-approval.
- `balanced`: 3 parallel, 2 retries, 2 improvements, 2 hours, 8 commits, 2M/run, 500K/task.
- `aggressive`: 6 parallel, 3 retries, 4 improvements, 4 hours, 25 commits, 5M/run, 1M/task.

Why it exists:

Autonomous coding needs bounded risk. Policy is the safety envelope.

## 16. Gates

### `src/services/orchestration/gates.ts`

Static gates:

- typecheck
- lint
- test
- build
- security scan
- import cycle check

Package detection:

For each detected package directory:

- if `scripts.typecheck`, run `npm run typecheck`
- else if `tsconfig.json`, run `npx tsc --noEmit`
- if `scripts.lint`, run `npm run lint`
- if real `scripts.test`, run `npm run test`
- if `scripts.build`, run `npm run build`

Placeholder test scripts containing "no test specified" are skipped.

Timeouts:

- typecheck/tsc: 90000 ms
- lint: 60000 ms
- test: 180000 ms
- build: 120000 ms

Execution:

All gate tasks run concurrently with `Promise.all()`.

#### Security Scan

Detects likely secrets:

- API key literals
- password/secret literals
- private keys
- GitHub tokens
- `sk-*` style secret keys
- AWS access key IDs
- JWT tokens

Allowlisted:

- `.env.example`
- `.env.sample`
- test/spec files
- mocks
- fixtures

Why it exists:

Autonomous edits must not accidentally commit credentials.

#### Import Cycle Gate

Uses `shared/import-graph.ts` to build a relative import graph and DFS for cycles.

Why it exists:

Circular imports are a common hidden regression in TypeScript/React/Nest projects.

#### Runtime Gate

`runRuntimeGate()` delegates to `runProjectRuntimeGate()`.

It returns:

- `runtime`
- `runtime:url`

Why it exists:

Static gates do not prove the app starts. Runtime gate tries to launch the target app and report a local URL.

## 17. Runtime Gate Configuration

### `src/services/orchestration/runtime-gate-config.ts`

This file resolves runtime services either from manual config or auto-detection.

Manual config path in target repo:

```text
.unity/gates.json
```

Manual service fields:

- `name`
- `cwd`
- `startCommand`
- `readySignal`
- `port`
- `healthCheck`
- `timeoutMs`
- `requiresNodeModules`
- `type`
- `env`

Auto-detected frameworks:

- Expo
- NestJS
- Next.js
- Vite
- generic Node backend with `start` or `start:dev`

Backend/frontend linking:

If both backend and frontend are detected, it sets:

```text
EXPO_PUBLIC_API_URL
```

for the frontend.

Why it exists:

Runtime validation should work for more than one hardcoded stack.

### `src/services/orchestration/runtime-gate.ts`

This starts detected services.

Flow:

1. Kill tracked processes from previous gates.
2. Resolve runtime manifest.
3. Ensure `node_modules` exists, auto-install if missing.
4. Kill configured ports.
5. Start backend/generic/frontend services in order.
6. Wait for each ready signal.
7. Inject backend URL before starting frontend.
8. Return primary local/public URLs.

Why it exists:

It makes "does the app boot?" part of autonomous verification.

## 18. Branches And Worktrees

### `src/services/orchestration/branch-manager.ts`

This file owns integration branch and commit operations for autonomous runs.

Functions:

- `detectDefaultBranch(repoPath)`
- `ensureIntegrationBranch(workspace, integrationBranch)`
- `commitAllChanges(repoPath, commitMessage)`
- `predictCherryPickConflict(repoPath, commitSha)`
- `cherryPickCommit(repoPath, commitSha)`
- `pushBranch(repoPath, branchName)`
- `checkoutBranch(repoPath, branchName)`
- `getDiffAgainstHead(repoPath)`

Git retry:

`withRetry()` retries transient Git/network failures such as SSL, timeouts, reset, DNS, 5xx, early EOF, and push "fetch first" cases.

Cherry-pick behavior:

- Try regular `git cherry-pick`.
- On conflict, collect conflict files.
- Try auto-resolving by accepting `--theirs` for conflict files.
- Continue cherry-pick if all conflicts resolve.
- Abort if unresolved.

Why it exists:

Autonomous tasks produce isolated commits. This module integrates them into a shared branch with retry and conflict handling.

### `src/services/orchestration/worktree-manager.ts`

This file creates and removes task worktrees.

Features:

- `WorktreeMutex` prevents concurrent worktree create/remove/prune races.
- Worktrees live under:

```text
workspaces/.unity-worktrees/<runId>/<taskId>
```

- Branch names look like:

```text
unity-task-<runId>-<taskId>
```

- Copies `.env` files from base workspace.
- Symlinks `node_modules` from base packages for speed.
- If write scope touches dependency files, installs isolated dependencies instead of symlinking.

Dependency-changing scope detection:

- `package.json`
- `package-lock.json`
- `yarn.lock`
- `pnpm-lock.yaml`

Why it exists:

Parallel autonomous tasks need isolated filesystems and branches, but should avoid reinstalling dependencies unless necessary.

## 19. Multi-Repo Orchestration

### `src/services/orchestration/multi-repo.ts`

This module supports planning work across multiple repositories.

It defines:

- `RepoDescriptor`
- `MultiRepoConfig`
- `MultiRepoPlan`
- `MultiRepoRunState`

Main functions:

- `planMultiRepoRun()`
- `resolveMultiRepoExecutionOrder()`
- `buildCoordinatedPrBody()`
- `loadMultiRepoConfig()`

Planner role:

- `planning`

Purpose:

For cross-repo changes, it can split tasks by repo, define cross-repo dependencies, and build coordinated PR descriptions.

Execution ordering:

`resolveMultiRepoExecutionOrder()` uses Kahn's algorithm to topologically sort tasks into phases.

Current wiring detail:

No Discord, HTTP, or application flow currently calls `planMultiRepoRun()`. This is available infrastructure, not part of the primary runtime path yet.

ESM caveat:

`loadMultiRepoConfig()` uses `require('fs')` and `require('path')` inside an ESM project (`"type": "module"`). That function may need adjustment before use.

## 20. Persistence

### `src/services/persistence/unity-store.ts`

This is the main SQLite store at:

```text
.unity/unity-agent.sqlite
```

It uses `node:sqlite` `DatabaseSync`, WAL journal mode, and normal synchronous mode.

Tables:

- `runs`
- `plans`
- `tasks`
- `events`
- `artifacts`
- `memories`
- `policies`
- `night_jobs`

Important methods:

- `createRun()`, `updateRun()`, `getRun()`, `listRuns()`
- `createPlan()`, `updatePlan()`, `getLatestPlanByRun()`, `listPlansByRun()`
- `createTask()`, `updateTask()`, `getTask()`, `listTasksByRun()`
- `addEvent()`, `listEventsByRun()`
- `addArtifact()`, `listArtifactsByRun()`
- `upsertPolicy()`, `getPolicy()`
- `upsertMemory()`
- `listResumableRuns()`
- `getRunProgress()`
- `resetInterruptedTasks()`
- `createNightJob()`

Why it exists:

Autonomous runs need to survive approval delays, process crashes, and long execution windows. The HTTP console is mostly a view over this store.

Memory layers:

- `stable_repo`
- `run_context`
- `continuous_improvement`

Indexes:

The store adds indexes for hot paths such as tasks by run, events by run/task, artifacts by run/task, plans by run, runs by status/project, and night jobs by project/status.

## 21. Telemetry And Token Tracking

### `src/services/telemetry/telemetry-store.ts`

SQLite path:

```text
.unity/unity-telemetry.sqlite
```

Stores telemetry events with:

- run ID
- task ID
- project name
- event name
- duration
- input/output/total tokens
- estimated cost
- model
- status
- metadata

Cost estimates per 1M tokens:

- `deepseek-v4-pro`: 2.19
- `deepseek-reasoner`: 2.19
- `deepseek-chat`: 0.27
- `claude-opus-4`: 75.0
- `claude-sonnet-4`: 15.0
- `claude-haiku-4-5`: 4.0

Query methods:

- `getRunCostSummary(runId)`
- `getTaskCosts(runId)`
- `listEventsByRun(runId)`
- `getProjectStats(projectName, days)`
- `getGateStats(projectName, days)`
- `getEditMetrics(projectName, days)`

Current wiring detail:

The telemetry API object has many event methods, but the main code path currently emits very little telemetry. `agent-runner.ts` emits `agent.redirect_spiral`; HTTP and Discord read telemetry for cost/analytics. Many telemetry methods are ready but not widely called from gates/tasks/completions.

### `src/services/telemetry/index.ts`

Public telemetry API.

Methods:

- `taskStarted`
- `taskCompleted`
- `taskFailed`
- `gatePassed`
- `runStarted`
- `runCompleted`
- `editApplied`
- `editFailed`
- `redirectSpiral`

Why it exists:

It gives the rest of the system a typed way to emit structured analytics without knowing SQLite details.

### `src/services/ai/token-tracker.ts`

In-memory token budget tracker.

Tracks:

- run total
- task total
- warning threshold, default 0.75
- exceeded status

Default budget:

```text
maxTokensPerRun: 0
maxTokensPerTask: 0
```

`0` means unlimited.

Why it exists:

LLM calls can run away in autonomous loops. This module is intended to enforce per-run and per-task token budgets.

Current wiring detail:

The policy has token budgets, and `roleCompletion()` records usage, but the global tracker is not initialized from policy in the main autonomous flow. So the enforcement path exists, but policy-backed enforcement appears incomplete.

## 22. Learning System

The learning system is a closed loop:

```text
successful task
  -> extractPattern()
  -> save pattern
  -> future task calls buildLearningContext()
  -> inject matched patterns into implementer prompt
  -> record whether injected patterns helped
  -> update effectiveness score
```

### `src/services/learning/learning-store.ts`

SQLite path:

```text
.unity/unity-learning.sqlite
```

Tables:

- `patterns`
- `pattern_outcomes`

`LearnedPattern` stores:

- project name
- task kind
- file pattern
- tags
- approach summary
- iterations
- tokens used
- files read
- files edited
- top tools
- times applied
- times succeeded
- times failed
- effectiveness score
- source run/task

Relevance scoring:

- same project: +0.3
- same task kind: +0.2
- file scope overlap: up to +0.25
- keyword/tag overlap: up to +0.25
- effectiveness bonus: up to +0.1 after 2+ applications
- temporal decay: patterns older than 90 days shrink toward 30 percent weight

Effectiveness score:

```text
(timesSucceeded - timesFailed) / timesApplied
```

Pruning:

Patterns with at least 3 applications and score below -0.5 can be deleted.

Deduplication:

Same project, kind, and file pattern keeps the highest-score pattern.

### `src/services/learning/prompt-injector.ts`

Builds prompt guidance for a task.

It:

1. Extracts simple keywords from title and prompt.
2. Finds top 3 relevant patterns.
3. Formats them as guidance.
4. Returns applied pattern IDs for later outcome tracking.

Where it runs:

`executeTask()` calls `buildLearningContext()` before code generation.

### `src/services/learning/pattern-extractor.ts`

Runs after successful autonomous tasks.

It:

- skips trivial tasks,
- computes keywords,
- computes file pattern,
- computes top tools,
- optionally asks role `repair` to summarize the successful approach,
- saves the pattern.

Where it runs:

`executeTask()` calls `extractPattern()` after a successful task commit and gates.

Why learning exists:

The server should improve over time by remembering which approaches worked in which file scopes and task kinds.

## 23. Knowledge Graph

### `src/services/knowledge/knowledge-graph.ts`

SQLite path:

```text
.unity/unity-knowledge.sqlite
```

Tracks:

- modules
- API endpoints
- architecture decisions
- file change log
- hot files
- fragile areas

Module data:

- module path
- module type
- exports
- dependencies
- dependents
- change frequency
- failure frequency
- fragility score
- notes

Module type inference:

- test
- component
- service
- route
- config
- domain
- infra
- util

`scanProjectStructure(projectName, repoPath)`:

1. Builds import graph with `shared/import-graph.ts`.
2. Groups files by first two path segments.
3. Computes module dependencies and dependents.
4. Extracts named exports from up to 10 files per module.
5. Upserts modules.

Where it runs:

`createAutonomousRunPlan()` and `resumeAutonomousRun()` populate the graph if the project has zero modules.

`updateAfterRun()`:

- records file changes,
- creates module nodes if missing,
- increments change/failure counters.

Prompt injection:

Explorer calls `kg.buildPromptContext(projectName)` to include fragile areas, frequently changed files, API surface, and architecture decisions.

Why it exists:

The agent should know which modules are hot, fragile, or architecturally important before editing.

Current detail:

The post-run knowledge update in `run-autonomous-agent.ts` derives changed files from `task.outputSummary` first, then falls back to write scope. Because summaries are natural language, this may be less accurate than parsing the persisted diff artifact.

### `src/shared/import-graph.ts`

Shared utility for:

- resolving relative import paths,
- building import graphs for `.ts`, `.tsx`, `.js`, `.jsx`,
- supporting both import-cycle gates and knowledge graph scanning.

Why it exists:

Avoids duplicating import parsing in gates and knowledge services.

## 24. Discord Transport

### `src/transports/discord/register-handlers.ts`

This file handles:

- messages in manual and autonomous channels,
- button interactions,
- slash commands.

Configured channel names:

- manual: `UNITY_MANUAL_CHANNEL` or `jarvis-dev`
- autonomous: `UNITY_AUTONOMOUS_CHANNEL` or `unity-agent`

### Manual Channel Flow

Sequence:

```text
message in manual channel
  -> reject if runtime busy
  -> detect iteration by message.reference
  -> if fresh, block when git status is dirty
  -> start processing
  -> reply with cancel button
  -> create Discord thread
  -> runDevelopmentTask()
  -> remember session
  -> attach screenshot and diff
  -> show Approve & PR / Revert buttons
```

Approve button:

- Calls `approveSession()`.
- Generates smart commit metadata.
- Creates PR.
- Deletes session from runtime memory.

Reject button:

- Calls `rejectSession()`.
- Resets workspace.
- Deletes session.

Cancel button:

- Aborts current task through `RuntimeState`.
- Manual catch path resets workspace.

Why it exists:

This is the fastest interactive loop for "make this change and show me."

### Autonomous Channel Flow

Sequence:

```text
message in autonomous channel
  -> reject if runtime busy
  -> start processing
  -> create cancel button and thread
  -> createAutonomousRunPlan(mode: interactive)
  -> post run ID, branch, console URL, task list
  -> archive thread
  -> finish processing
```

Important:

Discord autonomous flow only creates the plan. It does not execute tasks. The local HTTP console must approve and resume the run.

### Slash Commands Handled

Handlers exist for:

- `/status`
- `/policy`
- `/cost`
- `/learning`
- `/workon`
- `/init`

Current registration detail:

`utils/register-commands.ts` registers only:

- `/workon`
- `/status`
- `/policy`
- `/init`

So `/cost` and `/learning` are handled in code but are not currently registered by the provided command registration script.

## 25. HTTP Console

### `src/transports/http/server.ts`

This starts the local console on:

```text
http://localhost:<UNITY_LOCAL_CONSOLE_PORT>
```

Default:

```text
http://localhost:4477
```

Pages:

- `/`: run list and health/overview.
- `/runs/:runId`: detailed run page with graph, task list, events, artifacts, actions.
- `/analytics`: cost, gates, edit reliability, model usage, run status.
- `/knowledge`: modules, fragile areas, decisions, API endpoints, file changes.
- `/settings`: policy editor.
- `/learning`: learned pattern browser.

Core API routes:

- `GET /health`
- `GET /api/runs`
- `GET /api/runs/resumable`
- `GET /api/runs/:id`
- `GET /api/runs/:id/plan`
- `GET /api/runs/:id/tasks`
- `GET /api/runs/:id/events`
- `GET /api/runs/:id/artifacts`
- `GET /api/runs/:id/plans`
- `POST /api/runs/:id/approve-plan`
- `POST /api/runs/:id/reject-plan`
- `POST /api/runs/:id/cancel`
- `GET /api/runs/:id/cost`
- `GET /api/runs/:id/telemetry`
- `GET /api/runs/:id/diff`
- `POST /api/runs/:id/rerun-failed`
- `GET /api/runs/:id/timeline`
- `GET /api/runs/:id/task-costs`
- `GET /api/telemetry/stats`
- `GET /api/telemetry/gate-stats`
- `GET /api/telemetry/edit-metrics`
- `GET /api/learning/patterns`
- `GET /api/learning/patterns/:id/outcomes`
- `GET /api/learning/stats`
- `GET /api/knowledge/snapshot`
- `GET /api/knowledge/hot-files`
- `GET /api/knowledge/fragile`
- `GET /api/knowledge/decisions`
- `POST /api/knowledge/decisions`
- `GET /api/knowledge/modules`
- `GET /api/knowledge/api-endpoints`
- `GET /api/knowledge/file-changes`
- `GET /api/policies/:project`
- `PUT /api/policies/:project`

Plan approval:

Both HTML form route and JSON API route call:

```ts
approveAutonomousRunPlan()
resumeAutonomousRun()
```

The resume runs in the background and adds `run.progress` events to the store.

Why it exists:

Autonomous work needs human review and operational visibility. The console is the control room.

## 26. GitHub Webhooks

### `src/transports/webhooks/github-handler.ts`

Endpoint:

```text
POST /webhooks/github
```

Supported triggers:

- Issue comment or PR review comment containing `/unity run <prompt>`.
- Push events to configured branches when enabled.

Configuration:

- `UNITY_WEBHOOK_SECRET`
- `UNITY_TRIGGER_BRANCHES`
- `UNITY_WEBHOOK_PR_COMMENTS`
- `UNITY_WEBHOOK_PUSH`

Security:

If a webhook secret is configured, the handler verifies `x-hub-signature-256` with HMAC-SHA256.

Current behavior:

- PR/comment and push triggers call `createAutonomousRunPlan()` with mode `auto`.
- Since `shouldAutoApprovePlan()` only auto-approves `nightly`, webhook-created runs generally wait for approval.

Current wiring caveat:

The `onProgress` callback inside `handlePrComment()` and `handlePush()` references `result.runId` before `result` is initialized. If `createAutonomousRunPlan()` emits progress before returning, that callback can throw. This should be fixed before relying heavily on webhooks.

## 27. Project Scaffolding

### `src/templates.ts`

Creates starter apps.

`initExpoProject()`:

- runs `npx create-expo-app`
- installs Zustand, Axios, SecureStore, AsyncStorage, Oswald fonts, NativeWind, Tailwind
- writes Tailwind config
- writes Babel config
- creates `components/ui`, `theme`, `store`, `api`, `constants`
- writes theme tokens
- writes auth store
- writes Axios client
- writes `.unityrc.md` architecture rules

`initNestProject()`:

- runs Nest CLI
- installs Mongoose, JWT, Passport, bcrypt, class-validator, Swagger
- creates common folders
- modifies `src/main.ts` to enable CORS and Swagger
- writes `.unityrc.md` architecture rules

`initFullstackProject()`:

- creates monorepo root
- creates `api`
- creates `mobile`

Why it exists:

This lets the Discord bot bootstrap target projects with conventions the AI prompt understands.

## 28. Utilities

### `utils/register-commands.ts`

Registers Discord slash commands using Discord REST API.

Registered commands:

- `/workon`
- `/status`
- `/policy`
- `/init`

Current gap:

The runtime also handles `/cost` and `/learning`, but this script does not register them.

### `utils/test-models.js`

Small helper to list Gemini models available for `GEMINI_API_KEY`.

Current role:

Diagnostic legacy helper. The active provider stack uses DeepSeek.

## 29. End-To-End Flow Details

### Manual Request

```text
Discord #jarvis-dev
  -> registerDiscordHandlers()
  -> runDevelopmentTask()
  -> prepareWorkspace() or resolveWorkspace()
  -> getFigmaContext()
  -> getProjectTree()
  -> getProjectMemory()
  -> generateAndWriteCode()
       role: code-gen
       model: deepseek-v4-pro
       thinking: enabled
       reasoning_effort: max
       max_tokens: 120000
  -> applyEditsToFiles()
  -> runTypecheckForDirs()
  -> takeSnapshot()
  -> return snapshot/diff/buttons
  -> approveSession()
       role: pr-metadata
       model: deepseek-v4-pro
       thinking: disabled
       temperature: 0.4
       max_tokens: 10000
  -> createPullRequest()
```

Why this flow is designed this way:

- Manual work needs immediate feedback.
- It keeps uncommitted changes in the workspace for iteration.
- It requires explicit user approval before pushing a PR.

### Autonomous Request

```text
Discord #unity-agent or HTTP/webhook
  -> createAutonomousRunPlan()
  -> prepareWorkspace()
  -> ensureIntegrationBranch()
  -> runStaticGates() baseline
  -> planAutonomousRun()
       role: planning
       model: deepseek-v4-pro
       thinking: enabled primary, disabled fallback
       reasoning_effort: high
       max_tokens: 120000
  -> persist plan
  -> await approval
  -> resumeAutonomousRun()
  -> executeApprovedRun()
  -> for each runnable scoped task batch:
       createTaskWorktree()
       runStaticGates() scoped baseline
       buildLearningContext()
       runExplorerAgent()
          role: explorer
          thinking: enabled
          reasoning_effort: high
          max_tokens: 120000
       runArchitectAgent()
          role: architect
          thinking: enabled
          reasoning_effort: max
          max_tokens: 120000
       generateAndWriteCode()
          role: code-gen
          thinking: enabled
          reasoning_effort: max
          max_tokens: 120000
       commitAllChanges()
       scope gate
       runStaticGates() scoped current
       baseline-delta gate
       reviewTaskResult()
          role: review
          thinking: disabled
          temperature: 0
          max_tokens: 30000
       integrateTaskResult()
       extractPattern()
  -> final static gates
  -> runtime gate
  -> closure assessment
  -> knowledge graph update
  -> final run status
```

Why this flow is designed this way:

- Planning separates a big request into safe work units.
- Worktrees isolate parallel edits.
- Write scopes prevent uncontrolled blast radius.
- Baseline-delta gates avoid punishing pre-existing failures.
- Reviewer produces narrative context without overriding deterministic safety.
- Integration branch provides a single merge target.
- Persistence makes the run observable and resumable.

## 30. Current Known Gaps And Sharp Edges

These are not guesses. They follow from the current code wiring.

1. Token policy is not fully enforced.
   `AutonomousRunPolicy` has token budgets, and `roleCompletion()` records tokens, but `getTokenTracker()` is not initialized from project policy in the main run flow. Default budgets are unlimited.

2. Telemetry dashboards may be sparse.
   The telemetry store and HTTP analytics endpoints exist, but most telemetry emitters are not called in the main task/gate/completion flow. `redirectSpiral` is emitted; many other event types are ready but not wired.

3. `TaskQueue` is infrastructure, not the primary scheduler.
   The queue exists in `RuntimeState`, but autonomous tasks are scheduled directly with `Promise.all()`.

4. `/cost` and `/learning` Discord handlers are not registered by `utils/register-commands.ts`.
   The bot code can handle them, but Discord will not expose them unless the registration script is updated.

5. `auto` webhook mode does not auto-approve.
   `shouldAutoApprovePlan()` only auto-approves `nightly`, so webhook runs created with mode `auto` will usually wait for approval.

6. Webhook progress callbacks reference `result` before initialization.
   This can break if progress is emitted while `createAutonomousRunPlan()` is still awaiting.

7. Multi-repo orchestration is not wired into transports.
   `multi-repo.ts` is a strong planning utility, but no route/command currently uses it.

8. Runtime port cleanup assumes `fuser`.
   On systems without `fuser`, cleanup may not work.

9. Knowledge graph post-run changed-file attribution is approximate.
   It should ideally parse diff artifacts, but currently may use task output summaries or write scopes.

10. Root `npm test` is a placeholder.
   There is no server-side automated test suite wired into the root package.

## 31. Why The Major Pieces Exist

The repo has many modules because autonomous coding needs several separate safety layers.

Planning exists because a single huge prompt is too risky. It scopes work into smaller pieces.

Write scopes exist because autonomous agents need boundaries that can be checked after the fact.

Worktrees exist because parallel tasks must not overwrite each other in the same filesystem.

Baseline gates exist because target repos can already be broken. The agent should be judged on new regressions, not old failures.

Reviewer exists because deterministic gates say "safe or not", but humans still need summaries, findings, and possible follow-ups.

Runtime gates exist because TypeScript passing does not mean an app boots.

SQLite persistence exists because autonomous work is long-running, approval-driven, and should survive restarts.

Learning exists because future agents should reuse approaches that worked.

Knowledge graph exists because the agent should know hot and fragile modules before touching them.

Telemetry exists because cost, iteration count, gate health, and edit reliability are necessary to improve the system over time.

Discord exists because it is the operator input surface.

HTTP console exists because autonomous runs need richer review and control than Discord messages can comfortably provide.

## 32. Mental Model For Future Maintainers

If you are modifying this server, keep these boundaries in mind:

- Transport code should translate user actions into application workflow calls.
- Application code should orchestrate workflows but not know low-level provider payloads.
- AI services should own prompts, model role config, provider details, tools, edits, and validation.
- Orchestration services should own policies, gates, branches, worktrees, planning, review, and runtime verification.
- Persistence services should store facts, not decide behavior.
- Knowledge and learning should inform prompts, not override safety gates.

The safest way to extend the system is:

1. Add a typed domain shape if needed.
2. Persist new durable state in a store.
3. Wire it into application flow.
4. Surface it in HTTP or Discord.
5. Add gate or policy controls if the behavior can increase risk.

## 33. Quick File Reference

```text
index.ts
  Boots Discord and HTTP console.

src/config.ts
  Runtime env/config and project path helpers.

src/git.ts
  Target repo clone/reset/pull/status/diff/PR/scaffold.

src/scanner.ts
  Shallow project tree and .unityrc memory.

src/figma.ts
  Figma URL detection and compact node JSON.

src/snapshot.ts
  Manual preview server and Puppeteer screenshot.

src/templates.ts
  Expo/Nest/fullstack scaffolding.

src/application/run-development-task.ts
  Manual Discord code-generation workflow.

src/application/approve-session.ts
  Manual approval to GitHub PR.

src/application/reject-session.ts
  Manual rejection/reset.

src/application/run-autonomous-agent.ts
  Autonomous plan/approve/resume/execute/integrate/close.

src/services/ai/model-router.ts
  Role to model settings.

src/services/ai/completion.ts
  Unified role completion entry point.

src/services/ai/providers/*
  Provider abstraction and DeepSeek implementation.

src/services/ai/agent-runner.ts
  Tool-using implementer loop.

src/services/ai/agent-roles.ts
  Explorer and Architect pipeline.

src/services/ai/prompt-builder.ts
  Implementer system prompt.

src/services/ai/edit-operations.ts
  JSON parsing and atomic edit application.

src/services/ai/validation-service.ts
  Scoped TypeScript validation.

src/services/ai/loop-heuristics.ts
  Spiral/stale exploration control.

src/tools.ts
  LLM tool runtime.

src/services/orchestration/planner.ts
  Autonomous task planner.

src/services/orchestration/reviewer.ts
  LLM reviewer plus deterministic approval override.

src/services/orchestration/policy-engine.ts
  Defaults, presets, normalization.

src/services/orchestration/gates.ts
  Static gates, security scan, import cycle check.

src/services/orchestration/runtime-gate*.ts
  Runtime service detection/startup verification.

src/services/orchestration/branch-manager.ts
  Integration branch, commit, push, cherry-pick.

src/services/orchestration/worktree-manager.ts
  Per-task Git worktrees.

src/services/orchestration/multi-repo.ts
  Multi-repo planning infrastructure.

src/services/persistence/unity-store.ts
  Main run/task/plan/event/artifact/policy/memory SQLite store.

src/services/telemetry/*
  Telemetry and cost SQLite store.

src/services/learning/*
  Learned patterns and prompt injection.

src/services/knowledge/*
  Knowledge graph, hot files, fragile areas, decisions.

src/transports/discord/register-handlers.ts
  Discord messages, buttons, slash command handlers.

src/transports/http/server.ts
  Local console pages and JSON APIs.

src/transports/webhooks/*
  GitHub webhook triggers.

utils/register-commands.ts
  Discord slash command registration.
```

## 34. Final System Description

`brain-station` is a local AI development control plane. It listens to Discord and HTTP, prepares real GitHub repositories under `workspaces/`, feeds scoped context to DeepSeek-powered agents, edits code through guarded tools and atomic patches, validates changes through static and runtime gates, persists all important run state in SQLite, and gives the operator a console for approving, watching, and learning from autonomous development runs.

The design is strongest where it treats the LLM as one component in a larger system rather than as the whole system. The LLM proposes plans, explores code, writes patches, and reviews diffs. The server owns boundaries, persistence, validation, Git integration, and operational control.
