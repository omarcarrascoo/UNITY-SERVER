import fs from 'node:fs';
import path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execSync } from 'node:child_process';
import { getRuntimeConfig, WORKSPACE_DIR, getProjectByName } from '../../config.js';
import {
  approveAutonomousRunPlan,
  createAutonomousRunPlan,
  rejectAutonomousRunPlan,
  resumeAutonomousRun,
} from '../../application/run-autonomous-agent.js';
import { runDevelopmentTask } from '../../application/run-development-task.js';
import { RuntimeState } from '../../runtime/state.js';
import { unityStore } from '../../runtime/services.js';
import { createEntityId } from '../../shared/ids.js';
import { getTelemetryStore } from '../../services/telemetry/telemetry-store.js';
import { getLearningStore } from '../../services/learning/learning-store.js';
import { getKnowledgeGraph } from '../../services/knowledge/index.js';
import { handleGitHubWebhook } from '../webhooks/index.js';
import { normalizePolicy, getProjectPolicy } from '../../services/orchestration/policy-engine.js';
import { createPullRequestFromBranch, resolveWorkspace } from '../../git.js';
import { runProjectRuntimeGate } from '../../services/orchestration/runtime-gate.js';

type RunPayload = NonNullable<ReturnType<typeof buildRunPayload>>;

type UiTask = {
  id: string;
  runId: string;
  parentTaskId: string | null;
  title: string;
  prompt: string | null;
  role: string | null;
  kind: string | null;
  status: string;
  writeScope: string[];
  dependencies: string[];
  attempts: number;
  branchName: string | null;
  worktreePath: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  outputSummary: string | null;
  validationSummary: string | null;
  orderIndex: number;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  planOnly?: boolean;
};

type UiArtifact = {
  taskId: string | null;
  type: string;
  path: string | null;
  content: string | null;
  createdAt: string | null;
};

type UiEvent = {
  taskId: string | null;
  type: string;
  level: string;
  message: string;
  payload: unknown;
  createdAt: string | null;
};

type UiRunViewModel = {
  run: RunPayload['run'];
  plan: RunPayload['plan'];
  tasks: UiTask[];
  artifacts: UiArtifact[];
  events: UiEvent[];
  selectedTaskId: string | null;
  counts: {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    blocked: number;
    skipped: number;
    done: number;
    progress: number;
  };
  graph: {
    svgInner: string;
    viewBox: string;
    width: number;
    height: number;
    phasesCount: number;
  };
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/<\/script/gi, '<\\/script');
}

function safeText(value: unknown): string {
  return escapeHtml(String(value ?? ''));
}

function truncate(value: unknown, maxLength: number): string {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US');
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'completed':
    case 'succeeded':
      return '#4ade80';
    case 'completed_with_warnings':
      return '#f59e0b';
    case 'awaiting_plan_approval':
    case 'pending':
      return '#facc15';
    case 'failed':
    case 'blocked':
    case 'plan_rejected':
      return '#f87171';
    case 'running':
    case 'healing':
    case 'planning':
      return '#60a5fa';
    case 'cancelled':
    case 'skipped':
      return '#9ca3af';
    default:
      return '#d1d5db';
  }
}

function renderStatusBadgeHtml(status: string): string {
  const color = getStatusColor(status);
  return `<span class="status-badge" style="background:${color}15;color:${color};border:1px solid ${color}30;">${escapeHtml(
    status.replaceAll('_', ' '),
  )}</span>`;
}

function normalizeTasks(payload: RunPayload): UiTask[] {
  if (payload.tasks.length > 0) {
    return payload.tasks
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex)
      .map((task) => ({
        ...task,
        parentTaskId: task.parentTaskId ?? null,
        prompt: task.prompt ?? null,
        role: task.role ?? null,
        kind: task.kind ?? null,
        writeScope: task.writeScope || ['.'],
        dependencies: task.dependencies || [],
        branchName: task.branchName ?? null,
        worktreePath: task.worktreePath ?? null,
        commitSha: task.commitSha ?? null,
        commitMessage: task.commitMessage ?? null,
        outputSummary: task.outputSummary ?? null,
        validationSummary: task.validationSummary ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        startedAt: task.startedAt ?? null,
        finishedAt: task.finishedAt ?? null,
      }));
  }

  const planTasks = payload.plan?.rawPlan?.tasks || [];
  const titleToId = new Map<string, string>();

  planTasks.forEach((task, index) => {
    titleToId.set(task.title, `draft-${index}`);
  });

  return planTasks.map((task, index) => ({
    id: titleToId.get(task.title) || `draft-${index}`,
    runId: payload.run.id,
    parentTaskId: null,
    title: task.title,
    prompt: task.prompt,
    role: task.role || 'executor',
    kind: task.kind || 'implement',
    status: payload.run.status === 'plan_rejected' ? 'blocked' : 'pending',
    writeScope: task.writeScope || ['.'],
    dependencies: (task.dependencies || []).map((dependency) => titleToId.get(dependency)).filter(Boolean) as string[],
    attempts: 0,
    branchName: null,
    worktreePath: null,
    commitSha: null,
    commitMessage: null,
    outputSummary: task.rationale || null,
    validationSummary: null,
    orderIndex: index,
    createdAt: payload.run.createdAt,
    updatedAt: payload.run.updatedAt,
    startedAt: null,
    finishedAt: null,
    planOnly: true,
  }));
}

function buildLevels(tasks: UiTask[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();

  function computeLevel(taskId: string, trail: Set<string>): number {
    if (memo.has(taskId)) {
      return memo.get(taskId) as number;
    }

    if (trail.has(taskId)) {
      return 0;
    }

    const task = byId.get(taskId);
    if (!task) {
      return 0;
    }

    trail.add(taskId);
    const dependencies = (task.dependencies || []).filter((dependencyId) => byId.has(dependencyId));
    const level = dependencies.length
      ? Math.max(...dependencies.map((dependencyId) => computeLevel(dependencyId, trail))) + 1
      : 0;
    trail.delete(taskId);
    memo.set(taskId, level);
    return level;
  }

  for (const task of tasks) {
    computeLevel(task.id, new Set());
  }

  const levels: UiTask[][] = [];
  for (const task of tasks) {
    const level = memo.get(task.id) || 0;
    if (!levels[level]) {
      levels[level] = [];
    }
    levels[level].push(task);
  }

  for (const column of levels) {
    column.sort((left, right) => left.orderIndex - right.orderIndex);
  }

  return levels.filter(Boolean);
}

function buildGraph(
  tasks: UiTask[],
  selectedTaskId: string | null,
): UiRunViewModel['graph'] {
  if (tasks.length === 0) {
    return {
      width: 900,
      height: 420,
      viewBox: '0 0 900 420',
      phasesCount: 0,
      svgInner: `<text x="96" y="170" class="lane-label">No tasks yet</text><text x="96" y="202" class="lane-sub">The plan exists but no nodes were generated.</text>`,
    };
  }

  const levels = buildLevels(tasks);
  const nodeWidth = 280;
  const nodeHeight = 110;
  const columnGap = 120;
  const rowGap = 140;
  const marginX = 60;
  const marginY = 80;
  const positions = new Map<string, { x: number; y: number }>();
  let maxRows = 1;

  levels.forEach((column, columnIndex) => {
    maxRows = Math.max(maxRows, column.length);
    column.forEach((task, rowIndex) => {
      positions.set(task.id, {
        x: marginX + columnIndex * (nodeWidth + columnGap),
        y: marginY + rowIndex * rowGap,
      });
    });
  });

  const width =
    marginX * 2 + Math.max(1, levels.length) * nodeWidth + Math.max(0, levels.length - 1) * columnGap;
  const height = marginY + maxRows * rowGap + 90;

  const laneLabels = levels
    .map((column, index) => {
      const x = marginX + index * (nodeWidth + columnGap);
      return `<text x="${x}" y="36" class="lane-label">Phase ${index + 1}</text><text x="${x}" y="56" class="lane-sub">${column.length} node(s)</text>`;
    })
    .join('');

  const edges = tasks
    .flatMap((task) => {
      const target = positions.get(task.id);
      if (!target) return [];

      return (task.dependencies || []).map((dependencyId) => {
        const source = positions.get(dependencyId);
        if (!source) return '';
        const startX = source.x + nodeWidth;
        const startY = source.y + nodeHeight / 2;
        const endX = target.x;
        const endY = target.y + nodeHeight / 2;
        const curve = Math.max(40, (endX - startX) / 2);
        return `<path class="edge" stroke="#3f3f46" d="M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}" />`;
      });
    })
    .join('');

  const nodes = tasks
    .map((task) => {
      const position = positions.get(task.id) as { x: number; y: number };
      const color = getStatusColor(task.status);
      const active = selectedTaskId === task.id;
      const stroke = active ? color : '#3f3f46';
      const glow = active ? `drop-shadow(0 0 10px ${color}40)` : 'none';
      const scopeLabel = escapeHtml(truncate((task.writeScope || ['.']).join(', '), 30));
      const summary = escapeHtml(truncate(task.outputSummary || task.validationSummary || task.prompt || '', 44));

      return `<g class="node-group${active ? ' active' : ''}" data-task-id="${escapeHtml(task.id)}" transform="translate(${position.x} ${position.y})" style="filter:${glow}">
        <rect class="node-hitbox" x="-8" y="-8" rx="16" ry="16" width="${nodeWidth + 16}" height="${nodeHeight + 16}" />
        <rect class="node-card" x="0" y="0" rx="12" ry="12" width="${nodeWidth}" height="${nodeHeight}" fill="#18181b" stroke="${stroke}" stroke-width="1.5"/>
        <rect x="16" y="16" rx="6" ry="6" width="68" height="24" fill="${color}15" stroke="${color}30" />
        <text x="26" y="32" class="node-subtitle" fill="${color}">${escapeHtml(task.status.toUpperCase())}</text>
        <circle cx="250" cy="28" r="4" fill="${color}" />
        <text x="16" y="64" class="node-title">${escapeHtml(truncate(task.title, 28))}</text>
        <text x="16" y="84" class="node-subtitle">scope: ${scopeLabel}</text>
        <text x="16" y="100" class="node-foot">${summary}</text>
      </g>`;
    })
    .join('');

  return {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    phasesCount: levels.length,
    svgInner: `${laneLabels}${edges}${nodes}`,
  };
}

function buildRunCounts(tasks: UiTask[]) {
  const counts = {
    total: tasks.length,
    pending: tasks.filter((task) => task.status === 'pending').length,
    running: tasks.filter((task) => task.status === 'running').length,
    succeeded: tasks.filter((task) => task.status === 'succeeded').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    skipped: tasks.filter((task) => task.status === 'skipped').length,
    done: 0,
    progress: 0,
  };

  counts.done = counts.succeeded + counts.failed + counts.blocked + counts.skipped;
  counts.progress = counts.total ? Math.round((counts.done / counts.total) * 100) : 0;

  return counts;
}

function buildRunViewModel(payload: RunPayload, requestedTaskId?: string | null): UiRunViewModel {
  const tasks = normalizeTasks(payload);
  const selectedTask =
    tasks.find((task) => task.id === requestedTaskId) ||
    tasks[0] ||
    null;

  const counts = buildRunCounts(tasks);

  return {
    run: payload.run,
    plan: payload.plan,
    tasks,
    artifacts: payload.artifacts.map((artifact) => ({
      taskId: artifact.taskId ?? null,
      type: artifact.type,
      path: artifact.path ?? null,
      content: artifact.content ?? null,
      createdAt: artifact.createdAt ?? null,
    })),
    events: payload.events.map((event) => ({
      taskId: event.taskId ?? null,
      type: event.type,
      level: event.level,
      message: event.message,
      payload: event.payload,
      createdAt: event.createdAt ?? null,
    })),
    selectedTaskId: selectedTask?.id || null,
    counts,
    graph: buildGraph(tasks, selectedTask?.id || null),
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function extractRunId(pathname: string, suffix = ''): string | null {
  const base = '/api/runs/';
  if (!pathname.startsWith(base)) return null;

  const trimmed = pathname.slice(base.length);
  if (suffix && trimmed.endsWith(suffix)) {
    return trimmed.slice(0, -suffix.length);
  }

  if (!suffix && !trimmed.includes('/')) {
    return trimmed;
  }

  return null;
}

function extractConsoleRunId(pathname: string, suffix = ''): string | null {
  const base = '/runs/';
  if (!pathname.startsWith(base)) return null;

  const trimmed = pathname.slice(base.length);
  if (suffix && trimmed.endsWith(suffix)) {
    return trimmed.slice(0, -suffix.length);
  }

  if (!suffix && !trimmed.includes('/')) {
    return trimmed;
  }

  return null;
}

function buildRunPayload(runId: string) {
  const run = unityStore.getRun(runId);
  if (!run) {
    return null;
  }

  return {
    run,
    plan: unityStore.getLatestPlanByRun(runId),
    plans: unityStore.listPlansByRun(runId),
    tasks: unityStore.listTasksByRun(runId),
    events: unityStore.listEventsByRun(runId),
    artifacts: unityStore.listArtifactsByRun(runId),
  };
}

/**
 * In-memory ledger of pair-mode sessions. Pair runs do not persist to UnityStore
 * (they're legacy one-shot iterations), so we keep a lightweight record here so
 * the panel can at least show that they happened.
 */
interface PairSessionRecord {
  sessionId: string;
  projectName: string;
  prompt: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  commitMessage: string | null;
  error: string | null;
}
const pairSessions: PairSessionRecord[] = [];
const MAX_PAIR_SESSIONS = 50;

function recordPairSession(sessionId: string, projectName: string, prompt: string): PairSessionRecord {
  const record: PairSessionRecord = {
    sessionId,
    projectName,
    prompt,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    commitMessage: null,
    error: null,
  };
  pairSessions.unshift(record);
  if (pairSessions.length > MAX_PAIR_SESSIONS) pairSessions.length = MAX_PAIR_SESSIONS;
  return record;
}

function listAvailableProjects(): Array<{ name: string; repoPath: string; hasGit: boolean; hasDeploy: boolean }> {
  try {
    if (!fs.existsSync(WORKSPACE_DIR)) return [];
    const entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const repoPath = path.join(WORKSPACE_DIR, entry.name);
        return {
          name: entry.name,
          repoPath,
          hasGit: fs.existsSync(path.join(repoPath, '.git')),
          hasDeploy: fs.existsSync(path.join(repoPath, '.unity', 'deploy.json')),
        };
      })
      .filter((p) => p.hasGit)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function buildRunsListPayload() {
  return unityStore.listRuns(100).map((run) => {
    const latestPlan = unityStore.getLatestPlanByRun(run.id);
    const tasks = unityStore.listTasksByRun(run.id);
    const counts = buildRunCounts(
      tasks.map((task) => ({
        ...task,
        parentTaskId: task.parentTaskId ?? null,
        prompt: task.prompt ?? null,
        role: task.role ?? null,
        kind: task.kind ?? null,
        writeScope: task.writeScope || ['.'],
        dependencies: task.dependencies || [],
        branchName: task.branchName ?? null,
        worktreePath: task.worktreePath ?? null,
        commitSha: task.commitSha ?? null,
        commitMessage: task.commitMessage ?? null,
        outputSummary: task.outputSummary ?? null,
        validationSummary: task.validationSummary ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        startedAt: task.startedAt ?? null,
        finishedAt: task.finishedAt ?? null,
      })),
    );

    return {
      run,
      latestPlan,
      taskCounts: counts,
    };
  });
}

function buildActionsHtml(run: UiRunViewModel['run'], plan: UiRunViewModel['plan']) {
  if (run.status === 'awaiting_plan_approval' && plan?.status === 'proposed') {
    return `<div class="actions">
        <button class="btn-primary" id="approve-plan" type="button">Approve Plan</button>
        <button class="btn-danger" id="reject-plan" type="button">Reject Plan</button>
      </div>`;
  }

  if (run.status === 'running' || run.status === 'healing') {
    return `<div class="actions">
      <button class="btn-secondary" id="cancel-run" type="button">Cancel Active Run</button>
    </div>`;
  }

  if (run.status === 'failed' || run.status === 'completed_with_warnings') {
    return `<div class="actions">
      <button class="btn-secondary" id="rerun-failed" type="button">Re-run Failed Tasks</button>
      <button class="btn-secondary" id="view-diff" type="button">View Diff</button>
      <button class="btn-primary" id="create-pr" type="button">Create PR</button>
      <button class="btn-secondary" id="run-local" type="button">▶ Run Locally</button>
    </div>`;
  }

  if (run.status === 'completed') {
    return `<div class="actions">
      <button class="btn-secondary" id="view-diff" type="button">View Diff</button>
      <button class="btn-primary" id="create-pr" type="button">Create PR</button>
      <button class="btn-secondary" id="run-local" type="button">▶ Run Locally</button>
    </div>`;
  }

  return '';
}

function buildMetaGridHtml(vm: UiRunViewModel) {
  const cards = [
    ['Status', renderStatusBadgeHtml(vm.run.status)],
    ['Mode', safeText(vm.run.mode)],
    ['Branch', safeText(vm.run.branchName)],
    ['Plan', vm.plan ? renderStatusBadgeHtml(vm.plan.status) : '<span class="muted">Missing</span>'],
    ['Progress', `${vm.counts.progress}%`],
    ['Tasks', String(vm.counts.total)],
    ['Running', String(vm.counts.running)],
    ['Failed', String(vm.counts.failed)],
  ];

  return cards
    .map(
      ([label, value]) =>
        `<div class="meta-card"><div class="meta-label">${label}</div><div class="meta-value">${value}</div></div>`,
    )
    .join('');
}

function buildPlanMetaHtml(vm: UiRunViewModel) {
  if (!vm.plan) {
    return '<div class="muted" style="padding: 16px;">Plan not found.</div>';
  }

  const lifecycle = [
    ['Run status', renderStatusBadgeHtml(vm.run.status)],
    ['Plan status', renderStatusBadgeHtml(vm.plan.status)],
    ['Created', formatDateTime(vm.plan.createdAt)],
    [
      'Approved',
      vm.plan.approvedAt
        ? `${formatDateTime(vm.plan.approvedAt)} · ${safeText(vm.plan.approvedBy || 'unknown')}`
        : 'Pending',
    ],
    [
      'Rejected',
      vm.plan.rejectedAt
        ? `${formatDateTime(vm.plan.rejectedAt)} · ${safeText(vm.plan.rejectedBy || 'unknown')}`
        : '—',
    ],
    ['Tasks', String(vm.counts.total)],
  ];

  return (
    `<div class="kv-grid">` +
    lifecycle
      .map(
        ([label, value]) =>
          `<div class="meta-card"><div class="meta-label">${label}</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${value}</div></div>`,
      )
      .join('') +
    `</div>
    <div class="task-card" style="margin-top: 16px;">
      <div class="task-title">Plan Summary</div>
      <pre>${safeText(vm.plan.summary)}</pre>
    </div>` +
    (vm.plan.rejectedReason
      ? `<div class="task-card" style="margin-top: 16px; border-color: #f8717140;"><div class="task-title" style="color: #f87171;">Rejected Because</div><pre>${safeText(
          vm.plan.rejectedReason,
        )}</pre></div>`
      : '')
  );
}

function buildEventsHtml(events: UiEvent[]) {
  if (!events.length) {
    return '<div class="muted" style="padding: 16px;">No events yet.</div>';
  }

  return events
    .slice()
    .reverse()
    .map((event) => {
      const levelColor =
        event.level === 'error'
          ? getStatusColor('failed')
          : event.level === 'warning'
            ? getStatusColor('pending')
            : getStatusColor('running');

      return `<div class="timeline-item">
        <div class="timeline-dot" style="background:${levelColor}; box-shadow: 0 0 0 4px #09090b;"></div>
        <article class="event-card">
          <div class="event-top">
            <strong>${safeText(event.type)}</strong>
            <span class="muted">${safeText(formatDateTime(event.createdAt))}</span>
          </div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 6px;">${safeText(event.message)}</div>
          ${event.payload ? `<pre style="margin-top: 10px;">${safeText(JSON.stringify(event.payload, null, 2))}</pre>` : ''}
        </article>
      </div>`;
    })
    .join('');
}

function buildTaskListHtml(tasks: UiTask[], selectedTaskId: string | null) {
  if (!tasks.length) {
    return '<div class="muted" style="padding: 16px; text-align: center;">No tasks available yet.</div>';
  }

  return tasks
    .map((task) => {
      const active = selectedTaskId === task.id;
      const dependencyCount = task.dependencies.length;

      return `<button type="button" class="task-list-item${active ? ' active' : ''}" data-task-id="${safeText(task.id)}">
        <div class="task-list-top">
          <div class="task-list-title">${safeText(task.title)}</div>
          ${renderStatusBadgeHtml(task.status)}
        </div>
        <div class="chip-row" style="margin-top: 8px;">
          <span class="chip">${safeText(task.kind || 'implement')}</span>
          <span class="chip">attempts ${safeText(task.attempts)}</span>
          ${task.planOnly ? '<span class="chip">plan preview</span>' : ''}
        </div>
        <div class="task-list-meta" style="margin-top: 12px;">
          <span>scope: ${safeText((task.writeScope || ['.']).join(', '))}</span>
          <span>${dependencyCount ? `${dependencyCount} dependenc${dependencyCount === 1 ? 'y' : 'ies'}` : 'no deps'}</span>
        </div>
      </button>`;
    })
    .join('');
}

function buildInspectorHtml(vm: UiRunViewModel) {
  const task = vm.tasks.find((candidate) => candidate.id === vm.selectedTaskId);

  if (!task) {
    return '<div class="muted" style="padding: 16px; text-align: center;">Select a task to inspect.</div>';
  }

  const dependencyTitles = task.dependencies.map((dependencyId) => {
    const dependency = vm.tasks.find((candidate) => candidate.id === dependencyId);
    return dependency ? dependency.title : dependencyId;
  });

  const relatedEvents = vm.events
    .filter((event) => event.taskId === task.id)
    .slice(-4)
    .reverse();

  return `<div style="display: flex; flex-direction: column; gap: 16px;">
    <div class="split">
      <div class="task-title" style="font-size: 16px;">${safeText(task.title)}</div>
      ${renderStatusBadgeHtml(task.status)}
    </div>
    <div class="chip-row">
      <span class="chip">${safeText(task.kind || 'implement')}</span>
      <span class="chip">attempts ${safeText(task.attempts)}</span>
      ${task.planOnly ? '<span class="chip">plan preview</span>' : ''}
    </div>
    <div class="kv-grid">
      <div class="meta-card"><div class="meta-label">Scope</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText((task.writeScope || ['.']).join(', '))}</div></div>
      <div class="meta-card"><div class="meta-label">Dependencies</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText(dependencyTitles.length ? dependencyTitles.join(', ') : 'None')}</div></div>
      <div class="meta-card"><div class="meta-label">Branch</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText(task.branchName || vm.run.branchName || '—')}</div></div>
      <div class="meta-card"><div class="meta-label">Commit</div><div class="meta-value" style="font-size:13px; font-weight:normal;">${safeText(task.commitSha || '—')}</div></div>
    </div>
    <div class="task-card">
      <div class="meta-label">Summary</div>
      <pre>${safeText(task.outputSummary || task.validationSummary || task.prompt || 'No summary available.')}</pre>
    </div>
    ${
      relatedEvents.length
        ? `<div class="task-card">
            <div class="meta-label">Recent task events</div>
            <pre>${safeText(
              relatedEvents
                .map((event) => `[${formatDateTime(event.createdAt)}] ${event.type} → ${event.message}`)
                .join('\n\n'),
            )}</pre>
          </div>`
        : ''
    }
  </div>`;
}

function buildArtifactsHtml(vm: UiRunViewModel) {
  const task = vm.tasks.find((candidate) => candidate.id === vm.selectedTaskId);
  if (!task) {
    return '<div class="muted" style="padding: 16px;">Select a task to view artifacts.</div>';
  }

  const taskArtifacts = vm.artifacts.filter((artifact) => artifact.taskId === task.id);
  if (!taskArtifacts.length) {
    return '<div class="muted" style="padding: 16px;">No artifacts stored for this task.</div>';
  }

  return taskArtifacts
    .slice()
    .reverse()
    .map((artifact) => {
      const preview = artifact.content ? artifact.content.slice(0, 1000) : '(binary or path-only artifact)';
      return `<article class="task-card" style="margin-bottom: 12px;">
        <div class="event-top" style="margin-bottom: 8px;">
          <strong style="font-size: 13px;">${safeText(artifact.type)}</strong>
          <span class="muted" style="font-size: 12px;">${safeText(formatDateTime(artifact.createdAt))}</span>
        </div>
        ${artifact.path ? `<div class="muted" style="font-size: 12px; margin-bottom: 12px; font-family: monospace;">${safeText(artifact.path)}</div>` : ''}
        <pre>${safeText(preview)}</pre>
      </article>`;
    })
    .join('');
}

const GLOBAL_CSS = `
  :root {
    --bg-app: #09090b;
    --bg-sidenav: #121214;
    --bg-surface: #18181b;
    --border: #27272a;
    --text-main: #fafafa;
    --text-muted: #a1a1aa;
    --accent: #e4e4e7;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; overflow: hidden;
    color: var(--text-main);
    font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg-app);
    display: flex; flex-direction: column;
  }
  a { text-decoration: none; color: inherit; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: var(--text-muted); }

  /* ── Global Navigation ── */
  .global-nav {
    display: flex; align-items: center; gap: 2px;
    padding: 0 24px; height: 48px; min-height: 48px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-sidenav); flex-shrink: 0; z-index: 20;
  }
  .global-nav .brand {
    font-weight: 600; font-size: 14px; letter-spacing: 0.02em;
    margin-right: 28px; display: flex; align-items: center; gap: 8px;
    color: var(--text-main);
  }
  .global-nav .brand-dot {
    width: 8px; height: 8px; background: #fafafa; border-radius: 2px;
  }
  .global-nav .gn-link {
    padding: 6px 14px; border-radius: 6px;
    font-size: 13px; font-weight: 500; color: var(--text-muted);
    transition: all 0.15s; border: 1px solid transparent;
  }
  .global-nav .gn-link:hover { background: var(--bg-surface); color: var(--text-main); }
  .global-nav .gn-link.active { background: var(--bg-surface); color: var(--text-main); border-color: var(--border); }
  .global-nav .nav-spacer { flex: 1; }

  /* ── Page layout beneath the nav ── */
  .page-below-nav { flex: 1; display: flex; overflow: hidden; }

  .sidenav {
    width: 280px; min-width: 280px;
    background: var(--bg-sidenav);
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    padding: 16px; gap: 16px;
    z-index: 10;
  }
  .sidenav-header { padding: 8px 4px; display: flex; align-items: center; justify-content: space-between; }
  .sidenav-header h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
  .search-box {
    background: var(--bg-app); border: 1px solid var(--border);
    color: var(--text-main); padding: 10px 14px;
    border-radius: 8px; font-size: 13px; width: 100%;
    outline: none; transition: border 0.2s;
  }
  .search-box:focus { border-color: #52525b; }
  .runs-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }
  .run-nav-item {
    padding: 10px 12px; border-radius: 8px; cursor: pointer;
    display: flex; flex-direction: column; gap: 6px;
    color: var(--text-muted); transition: all 0.15s ease; border: 1px solid transparent;
  }
  .run-nav-item:hover { background: var(--bg-surface); color: var(--text-main); }
  .run-nav-item.active { background: var(--bg-surface); color: var(--text-main); border-color: var(--border); }
  .run-nav-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-nav-meta { font-size: 11px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .run-nav-status { display: flex; align-items: center; gap: 4px; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; }

  .main-content { flex: 1; overflow-y: auto; position: relative; display: flex; flex-direction: column; }
  .muted { color: var(--text-muted); }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 10px; }
  ::-webkit-scrollbar-thumb:hover { background: #52525b; }
`;

function buildHomePageShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Unity · Home</title>
    <style>
      ${GLOBAL_CSS}
      .home-body { display:flex; flex:1; overflow:hidden; }
      .home-sidebar {
        width:280px; min-width:280px; background:var(--bg-sidenav);
        border-right:1px solid var(--border); display:flex; flex-direction:column;
        padding:16px; gap:12px;
      }
      .home-sidebar h3 { margin:0; font-size:13px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; padding:4px; }
      .home-main { flex:1; overflow-y:auto; padding:32px 48px; }
      .home-header { margin-bottom:32px; }
      .home-header h1 { font-size:28px; font-weight:400; letter-spacing:-0.02em; margin:0 0 8px; }
      .home-header p { color:var(--text-muted); font-size:14px; margin:0; max-width:600px; line-height:1.6; }
      .stats-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:12px; margin-bottom:32px; }
      .stat-card {
        background:var(--bg-surface); border:1px solid var(--border);
        border-radius:var(--radius); padding:20px;
        display:flex; flex-direction:column; gap:6px;
      }
      .stat-label { font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); font-weight:600; }
      .stat-value { font-size:28px; font-weight:300; }
      .stat-sub { font-size:12px; color:var(--text-muted); }
      .section-title { font-size:16px; font-weight:500; margin:0 0 16px; }
      .quick-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:12px; margin-bottom:32px; }
      .quick-card {
        background:var(--bg-surface); border:1px solid var(--border);
        border-radius:var(--radius); padding:20px; cursor:pointer;
        transition:all 0.15s; display:flex; flex-direction:column; gap:6px;
      }
      .quick-card:hover { border-color:#52525b; transform:translateY(-1px); box-shadow:0 8px 24px rgba(0,0,0,0.2); }
      .quick-card .qc-title { font-size:14px; font-weight:500; }
      .quick-card .qc-desc { font-size:12px; color:var(--text-muted); }
      .runs-table { width:100%; border-collapse:collapse; font-size:13px; }
      .runs-table th { text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; }
      .runs-table td { padding:10px 12px; border-bottom:1px solid #1e1e21; }
      .runs-table tr { cursor:pointer; transition:background 0.1s; }
      .runs-table tbody tr:hover { background:var(--bg-surface); }
      .bar-track { height:6px; background:var(--bg-app); border-radius:99px; overflow:hidden; display:inline-block; width:80px; vertical-align:middle; }
      .bar-fill { height:100%; border-radius:99px; }
      .status-badge { display:inline-flex; align-items:center; padding:3px 8px; border-radius:99px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }
      .health-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px,1fr)); gap:12px; margin-bottom:32px; }
      .health-card {
        background:var(--bg-surface); border:1px solid var(--border);
        border-radius:var(--radius); padding:16px;
        display:flex; flex-direction:column; gap:8px;
      }
      .health-label { font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); font-weight:600; }
      .health-row { display:flex; justify-content:space-between; align-items:center; }
      .health-value { font-size:20px; font-weight:400; }
      .health-bar { height:4px; background:var(--bg-app); border-radius:99px; overflow:hidden; }
      .health-bar-fill { height:100%; border-radius:99px; transition:width 0.5s; }
    </style>
  </head>
  <body>
    ${buildGlobalNavHtml('/')}

    <div class="home-body">
      <aside class="home-sidebar">
        <h3>Recent Runs</h3>
        <input id="runs-search" class="search-box" type="text" placeholder="Search runs..." />
        <div id="runs" class="runs-list"></div>
      </aside>

      <main class="home-main">
        <div class="home-header">
          <h1>Dashboard</h1>
          <p>Autonomous orchestrator overview. Monitor runs, review system health, and navigate to detailed views.</p>
        </div>

        <div class="stats-grid" id="hero-metrics"></div>

        <h2 class="section-title">Launch New Run</h2>
        <div id="launch-panel" style="background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px; margin-bottom:32px;">
          <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap; align-items:stretch;">
            <select id="launch-project" style="flex:1; min-width:200px; background:var(--bg-app); border:1px solid var(--border); color:var(--text-main); padding:10px 14px; border-radius:8px; font-size:13px; outline:none;">
              <option value="">Loading projects...</option>
            </select>
          </div>
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px; margin-bottom:16px;">
            <button type="button" class="launch-mode-btn active" data-mode="interactive" style="background:var(--bg-app); border:1px solid #60a5fa80; border-radius:8px; padding:14px 16px; text-align:left; cursor:pointer; display:flex; flex-direction:column; gap:6px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="mode-indicator" style="width:6px; height:6px; border-radius:50%; background:#60a5fa;"></span>
                <span class="mode-title" style="font-size:13px; font-weight:600; color:#60a5fa; letter-spacing:0.01em;">Interactive Autonomous</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); line-height:1.5;">Plans a run and pauses for your approval before executing. Best for unfamiliar work.</div>
            </button>
            <button type="button" class="launch-mode-btn" data-mode="nightly" style="background:var(--bg-app); border:1px solid var(--border); border-radius:8px; padding:14px 16px; text-align:left; cursor:pointer; display:flex; flex-direction:column; gap:6px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="mode-indicator" style="width:6px; height:6px; border-radius:50%; background:var(--text-muted);"></span>
                <span class="mode-title" style="font-size:13px; font-weight:600; color:var(--text-muted); letter-spacing:0.01em;">Nightly Autonomous</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); line-height:1.5;">Auto-approves the plan and runs end-to-end. Best for well-scoped batched work.</div>
            </button>
            <button type="button" class="launch-mode-btn" data-mode="pair" style="background:var(--bg-app); border:1px solid var(--border); border-radius:8px; padding:14px 16px; text-align:left; cursor:pointer; display:flex; flex-direction:column; gap:6px;">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="mode-indicator" style="width:6px; height:6px; border-radius:50%; background:var(--text-muted);"></span>
                <span class="mode-title" style="font-size:13px; font-weight:600; color:var(--text-muted); letter-spacing:0.01em;">Pair</span>
              </div>
              <div style="font-size:11px; color:var(--text-muted); line-height:1.5;">Single iteration, no planner. Produces a diff and snapshot for quick back-and-forth.</div>
            </button>
          </div>
          <div style="position:relative;">
            <textarea id="launch-prompt" placeholder="Describe the change you want. Press Cmd/Ctrl+Enter to launch." style="width:100%; min-height:96px; max-height:280px; background:var(--bg-app); border:1px solid var(--border); color:var(--text-main); padding:12px 14px 28px; border-radius:8px; font-size:13px; line-height:1.6; outline:none; font-family:inherit; resize:none; overflow-y:auto; box-sizing:border-box;"></textarea>
            <div id="launch-charcount" style="position:absolute; bottom:8px; right:12px; font-size:11px; color:var(--text-muted); pointer-events:none; font-variant-numeric:tabular-nums;">0</div>
          </div>
          <div id="launch-recent" style="display:none; margin-top:10px; gap:6px; flex-wrap:wrap;"></div>
          <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-top:12px;">
            <div id="launch-hint" style="font-size:12px; color:var(--text-muted); flex:1; min-width:0;">Discord remains active for mobile use — the panel is an additional interface.</div>
            <button type="button" id="launch-submit" style="background:var(--text-main); color:var(--bg-app); border:none; border-radius:8px; padding:10px 20px; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; gap:8px; transition:opacity 0.15s;">
              <span id="launch-submit-label">Launch Run</span>
              <span id="launch-submit-kbd" style="font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(0,0,0,0.15); opacity:0.7; font-weight:500;">⌘↵</span>
            </button>
          </div>
          <div id="launch-status" style="margin-top:12px; font-size:12px; display:none;"></div>
        </div>

        <h2 class="section-title">System Health</h2>
        <div class="health-grid" id="health-grid"></div>

        <h2 class="section-title">Quick Links</h2>
        <div class="quick-grid">
          <a href="/analytics" class="quick-card"><div class="qc-title">Analytics</div><div class="qc-desc">Cost trends, gate health, edit reliability, and model usage breakdown.</div></a>
          <a href="/knowledge" class="quick-card"><div class="qc-title">Knowledge Graph</div><div class="qc-desc">Module boundaries, API endpoints, fragile areas, and architecture decisions.</div></a>
          <a href="/learning" class="quick-card"><div class="qc-title">Learning Patterns</div><div class="qc-desc">Extracted patterns with effectiveness scores and application history.</div></a>
          <a href="/settings" class="quick-card"><div class="qc-title">Settings</div><div class="qc-desc">Policy configuration, gate toggles, token budgets, and run parameters.</div></a>
        </div>

        <h2 class="section-title">All Runs</h2>
        <table class="runs-table" id="runs-table">
          <thead>
            <tr><th>Project</th><th>Status</th><th>Tasks</th><th>Progress</th><th>Mode</th><th>Created</th></tr>
          </thead>
          <tbody></tbody>
        </table>

        <h2 class="section-title" style="margin-top:32px;">Pair Sessions</h2>
        <table class="runs-table" id="pair-table">
          <thead>
            <tr><th>Session</th><th>Project</th><th>Prompt</th><th>Status</th><th>Started</th></tr>
          </thead>
          <tbody></tbody>
        </table>
      </main>
    </div>

    <script>
      let allRuns = [];
      const statusColors = { completed:'#4ade80', completed_with_warnings:'#f59e0b', succeeded:'#4ade80', awaiting_plan_approval:'#facc15', pending:'#facc15', failed:'#f87171', blocked:'#f87171', plan_rejected:'#f87171', running:'#60a5fa', healing:'#60a5fa', cancelled:'#9ca3af' };
      function safe(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
      function badge(s){var c=statusColors[s]||'#d1d5db';return '<span class="status-badge" style="background:'+c+'15;color:'+c+';border:1px solid '+c+'30;">'+safe(s.replaceAll('_',' '))+'</span>';}
      function bar(pct,color){return '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%;background:'+(color||'#4ade80')+'"></div></div>';}
      function ago(d){if(!d)return'—';var ms=Date.now()-new Date(d).getTime(),m=Math.round(ms/60000);if(m<1)return'just now';if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<24)return h+'h ago';return Math.round(h/24)+'d ago';}

      function renderMetrics(items){
        var aw=0,ac=0,co=0,nr=0,fa=0;
        items.forEach(function(i){
          var s=i.run.status;
          if(s==='awaiting_plan_approval')aw++;
          else if(s==='running'||s==='healing')ac++;
          else if(s==='completed')co++;
          else if(s==='completed_with_warnings')nr++;
          else if(s==='failed')fa++;
        });
        document.getElementById('hero-metrics').innerHTML=[
          ['Active Runs',ac,'#60a5fa'],['Awaiting Approval',aw,'#facc15'],['Completed',co,'#4ade80'],['Needs Review',nr,'#f59e0b'],['Failed',fa,'#f87171'],['Total Runs',items.length,'#e4e4e7']
        ].map(function(m){return '<div class="stat-card"><div class="stat-label">'+m[0]+'</div><div class="stat-value" style="color:'+m[2]+'">'+m[1]+'</div></div>';}).join('');
      }

      var MODE_META = {
        interactive: {color:'#60a5fa', label:'Interactive'},
        nightly: {color:'#a78bfa', label:'Nightly'},
        pair: {color:'#4ade80', label:'Pair'},
        auto: {color:'#d1d5db', label:'Auto'}
      };
      function modeBadge(mode){
        var m=MODE_META[mode]||{color:'#d1d5db',label:mode};
        return '<span style="display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:99px;background:'+m.color+'15;color:'+m.color+';border:1px solid '+m.color+'30;font-size:11px;font-weight:500;"><span style="width:5px;height:5px;border-radius:50%;background:'+m.color+';"></span>'+safe(m.label)+'</span>';
      }

      function renderRunsTable(items){
        var tbody=document.querySelector('#runs-table tbody');
        if(!items.length){tbody.innerHTML='<tr><td colspan="6" class="muted" style="text-align:center;padding:24px;">No runs yet.</td></tr>';return;}
        tbody.innerHTML=items.map(function(item){
          var r=item.run,tc=item.taskCounts||{};
          return '<tr onclick="location.href=\\'/runs/'+encodeURIComponent(r.id)+'\\'">'
            +'<td style="font-weight:500">'+safe(r.projectName)+'</td>'
            +'<td>'+badge(r.status)+'</td>'
            +'<td>'+safe((tc.succeeded||0)+'/'+(tc.total||0))+'</td>'
            +'<td>'+bar(tc.progress||0)+'<span style="font-size:11px;margin-left:6px;color:var(--text-muted)">'+(tc.progress||0)+'%</span></td>'
            +'<td>'+modeBadge(r.mode)+'</td>'
            +'<td style="color:var(--text-muted);font-size:12px">'+ago(r.createdAt)+'</td>'
            +'</tr>';
        }).join('');
      }

      async function renderHealth(){
        var [gR,eR,lR]=await Promise.all([
          fetch('/api/telemetry/gate-stats'),fetch('/api/telemetry/edit-metrics'),fetch('/api/learning/stats')
        ]);
        var gates=await gR.json(),edits=await eR.json(),learning=await lR.json();
        var gateTotal=0,gatePassed=0;
        gates.forEach(function(g){gateTotal+=g.total;gatePassed+=g.passed;});
        var gateRate=gateTotal>0?Math.round(gatePassed/gateTotal*100):0;
        var editRate=edits.total>0?Math.round(edits.applied/edits.total*100):0;
        var learnRate=learning.overallSuccessRate?Math.round(learning.overallSuccessRate*100):0;
        document.getElementById('health-grid').innerHTML=[
          ['Gate Pass Rate',gateRate+'%',gateRate,gateRate>70?'#4ade80':'#f59e0b'],
          ['Edit Success',editRate+'%',editRate,editRate>80?'#4ade80':'#f59e0b'],
          ['Learning Patterns',learning.totalPatterns||0,Math.min(100,(learning.totalPatterns||0)*10),'#60a5fa'],
          ['Pattern Success',learnRate+'%',learnRate,learnRate>50?'#4ade80':'#f59e0b']
        ].map(function(h){return '<div class="health-card"><div class="health-label">'+h[0]+'</div><div class="health-row"><div class="health-value">'+h[1]+'</div></div><div class="health-bar"><div class="health-bar-fill" style="width:'+h[2]+'%;background:'+h[3]+'"></div></div></div>';}).join('');
      }

      function filterRuns(items){
        var s=(document.getElementById('runs-search').value||'').toLowerCase().trim();
        return items.filter(function(i){return!s||[i.run.projectName,i.run.id,i.run.prompt].join(' ').toLowerCase().includes(s);});
      }

      function renderSidebar(items){
        var container=document.getElementById('runs');
        if(!items.length){container.innerHTML='<div class="muted" style="font-size:12px;padding:12px;text-align:center;">No runs found.</div>';return;}
        container.innerHTML=items.map(function(item){
          var c=statusColors[item.run.status]||'#d1d5db';
          return '<a class="run-nav-item" href="/runs/'+encodeURIComponent(item.run.id)+'">'
            +'<div class="run-nav-title">'+safe(item.run.projectName)+'</div>'
            +'<div class="run-nav-meta"><div class="run-nav-status"><div class="status-dot" style="background:'+c+'"></div><span>'+safe(item.run.status.replaceAll('_',' '))+'</span></div><span>'+(item.taskCounts?.progress||0)+'%</span></div>'
            +'</a>';
        }).join('');
      }

      async function loadRuns(){
        var r=await fetch('/api/runs');allRuns=await r.json();
        renderMetrics(allRuns);
        renderSidebar(filterRuns(allRuns));
        renderRunsTable(filterRuns(allRuns));
      }

      function renderPairSessions(sessions){
        var tbody=document.querySelector('#pair-table tbody');
        if(!sessions.length){tbody.innerHTML='<tr><td colspan="5" class="muted" style="text-align:center;padding:20px;">No pair sessions yet. Use the launcher above with Pair mode selected.</td></tr>';return;}
        var STATUS_COLORS={running:'#60a5fa', succeeded:'#4ade80', failed:'#f87171'};
        tbody.innerHTML=sessions.map(function(s){
          var c=STATUS_COLORS[s.status]||'#d1d5db';
          return '<tr>'
            +'<td style="font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted);">'+safe(s.sessionId.slice(0,20))+'</td>'
            +'<td style="font-weight:500">'+safe(s.projectName)+'</td>'
            +'<td style="color:var(--text-muted);font-size:12px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+safe(s.prompt)+'">'+safe(s.prompt)+'</td>'
            +'<td><span style="padding:3px 8px;border-radius:99px;background:'+c+'15;color:'+c+';border:1px solid '+c+'30;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">'+safe(s.status)+'</span></td>'
            +'<td style="color:var(--text-muted);font-size:12px">'+ago(s.startedAt)+'</td>'
            +'</tr>';
        }).join('');
      }

      async function loadPairSessions(){
        try{var r=await fetch('/api/pair-sessions');renderPairSessions(await r.json());}catch(e){console.error(e);}
      }

      // ── Launch panel (interactive autonomous + nightly autonomous + pair) ──
      let launchMode = 'interactive';
      const LAUNCH_HINTS = {
        interactive: 'Jarvis will plan the work and wait for your approval before executing. You can review the tasks first.',
        nightly: 'Jarvis will plan AND execute without asking. Good for well-scoped work where you trust the outcome.',
        pair: 'Single code iteration: one diff, one snapshot, no planner. Same behavior as the Discord #jarvis-dev channel.',
      };
      var ACTIVE_PROJECT_KEY = 'unity.activeProject';
      var projectsCache = [];
      async function loadProjects(){
        try {
          var r = await fetch('/api/projects');
          var projects = await r.json();
          projectsCache = projects;
          var sel = document.getElementById('launch-project');
          if (!projects.length) {
            sel.innerHTML = '<option value="">No projects found in workspaces/</option>';
            return;
          }
          // Mark which projects have a deploy config so the UI can hint it.
          sel.innerHTML = projects.map(function(p){
            return '<option value="'+safe(p.name)+'">'+safe(p.name)+(p.hasDeploy?' · 🚀 deploy ready':'')+'</option>';
          }).join('');
          // Restore the last-used "active project" so the panel remembers context.
          var saved = '';
          try { saved = localStorage.getItem(ACTIVE_PROJECT_KEY) || ''; } catch(e){}
          if (saved && projects.some(function(p){return p.name===saved;})) {
            sel.value = saved;
          }
          sel.onchange = function(){
            try { localStorage.setItem(ACTIVE_PROJECT_KEY, sel.value); } catch(e){}
          };
          // Persist initial selection too.
          try { if (sel.value) localStorage.setItem(ACTIVE_PROJECT_KEY, sel.value); } catch(e){}
        } catch(e) {
          console.error('Failed to load projects', e);
        }
      }

      const MODE_COLORS = { interactive: '#60a5fa', nightly: '#a78bfa', pair: '#4ade80' };
      function setLaunchMode(mode){
        launchMode = mode;
        var accent = MODE_COLORS[mode] || '#60a5fa';
        document.querySelectorAll('.launch-mode-btn').forEach(function(b){
          var active = b.dataset.mode === mode;
          b.classList.toggle('active', active);
          var btnAccent = MODE_COLORS[b.dataset.mode] || '#60a5fa';
          b.style.borderColor = active ? (btnAccent + '80') : 'var(--border)';
          var indicator = b.querySelector('.mode-indicator');
          var title = b.querySelector('.mode-title');
          if (indicator) indicator.style.background = active ? btnAccent : 'var(--text-muted)';
          if (title) title.style.color = active ? btnAccent : 'var(--text-muted)';
        });
        document.getElementById('launch-hint').textContent = LAUNCH_HINTS[mode] || '';
      }

      document.querySelectorAll('.launch-mode-btn').forEach(function(btn){
        btn.addEventListener('click', function(){ setLaunchMode(btn.dataset.mode); });
      });

      // ── Launch: textarea UX (auto-resize, char count, Cmd+Enter, prompt history) ──
      var promptEl = document.getElementById('launch-prompt');
      var charEl = document.getElementById('launch-charcount');
      var submitBtn = document.getElementById('launch-submit');
      var submitLabel = document.getElementById('launch-submit-label');
      var submitKbd = document.getElementById('launch-submit-kbd');
      var recentEl = document.getElementById('launch-recent');

      function autoResize(){
        promptEl.style.height = 'auto';
        promptEl.style.height = Math.min(promptEl.scrollHeight, 280) + 'px';
      }
      function updateCharCount(){
        var n = promptEl.value.length;
        charEl.textContent = n === 0 ? '0' : n.toLocaleString();
        charEl.style.color = n > 2000 ? '#f59e0b' : 'var(--text-muted)';
      }

      // Keyboard hint: use ⌘↵ on Mac, Ctrl+↵ elsewhere. If no OS detection, keep generic.
      if (navigator.platform && navigator.platform.indexOf('Mac') === -1) {
        submitKbd.textContent = 'Ctrl+↵';
      }

      // Load up to 5 recent prompts from localStorage for quick reuse.
      var RECENT_KEY = 'unity.launch.recent';
      function loadRecent(){
        try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch(e){ return []; }
      }
      function saveRecent(entry){
        var list = loadRecent();
        list = list.filter(function(e){ return e.prompt !== entry.prompt; });
        list.unshift(entry);
        list = list.slice(0, 5);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch(e){}
        renderRecent();
      }
      function renderRecent(){
        var list = loadRecent();
        if (!list.length) { recentEl.style.display = 'none'; return; }
        recentEl.style.display = 'flex';
        recentEl.innerHTML = '<span style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;align-self:center;margin-right:4px;">Recent</span>' +
          list.map(function(e, i){
            var truncated = e.prompt.length > 50 ? e.prompt.slice(0, 50) + '…' : e.prompt;
            return '<button type="button" class="recent-prompt" data-idx="'+i+'" style="background:var(--bg-app);border:1px solid var(--border);color:var(--text-muted);padding:4px 10px;border-radius:99px;font-size:11px;cursor:pointer;font-family:inherit;" title="'+safe(e.prompt)+'">'+safe(truncated)+'</button>';
          }).join('');
        document.querySelectorAll('.recent-prompt').forEach(function(btn){
          btn.onclick = function(){
            var entry = list[parseInt(btn.dataset.idx, 10)];
            if (!entry) return;
            promptEl.value = entry.prompt;
            if (entry.projectName) {
              var sel = document.getElementById('launch-project');
              if (Array.from(sel.options).some(function(o){ return o.value === entry.projectName; })) {
                sel.value = entry.projectName;
              }
            }
            if (entry.mode) setLaunchMode(entry.mode);
            autoResize();
            updateCharCount();
            promptEl.focus();
          };
        });
      }

      async function doLaunch(){
        if (submitBtn.disabled) return;
        var projectName = document.getElementById('launch-project').value;
        var prompt = promptEl.value.trim();
        var statusEl = document.getElementById('launch-status');

        if (!projectName || !prompt) {
          statusEl.style.display = 'block';
          statusEl.style.color = '#f87171';
          statusEl.textContent = 'Select a project and write a prompt before launching.';
          promptEl.focus();
          return;
        }

        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.7';
        submitLabel.textContent = 'Launching';
        submitKbd.style.display = 'none';
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--text-muted)';
        statusEl.textContent = 'Creating run on ' + projectName + '...';

        try {
          var endpoint = launchMode === 'pair' ? '/api/pair-sessions' : '/api/runs';
          var body = { projectName: projectName, prompt: prompt };
          if (launchMode !== 'pair') body.mode = launchMode; // interactive or nightly
          var resp = await fetch(endpoint, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(body),
          });
          var data = await resp.json();
          if (!resp.ok) throw new Error(data.error || 'Request failed');

          saveRecent({ prompt: prompt, projectName: projectName, mode: launchMode });

          if (launchMode !== 'pair' && data.runId) {
            statusEl.style.color = '#4ade80';
            statusEl.textContent = 'Run created. Redirecting to run page...';
            setTimeout(function(){ location.href = '/runs/' + encodeURIComponent(data.runId); }, 500);
          } else {
            statusEl.style.color = '#4ade80';
            statusEl.textContent = 'Pair session started (' + safe(data.sessionId) + '). Progress appears in the Pair Sessions table below and in the console logs.';
            promptEl.value = '';
            autoResize();
            updateCharCount();
            loadPairSessions();
          }
        } catch (err) {
          statusEl.style.color = '#f87171';
          statusEl.textContent = 'Failed: ' + (err.message || err);
        } finally {
          submitBtn.disabled = false;
          submitBtn.style.opacity = '1';
          submitLabel.textContent = 'Launch Run';
          submitKbd.style.display = 'inline-block';
        }
      }

      submitBtn.addEventListener('click', doLaunch);
      promptEl.addEventListener('input', function(){ autoResize(); updateCharCount(); });
      promptEl.addEventListener('keydown', function(e){
        if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.keyCode === 13)) {
          e.preventDefault();
          doLaunch();
        }
      });

      setLaunchMode('interactive');
      renderRecent();

      document.getElementById('runs-search').addEventListener('input',function(){renderSidebar(filterRuns(allRuns));renderRunsTable(filterRuns(allRuns));});
      loadRuns();
      renderHealth();
      loadProjects();
      loadPairSessions();
      setInterval(loadRuns,5000);
      setInterval(loadPairSessions,5000);
    </script>
  </body>
</html>`;
}

function renderRunPage(
  runId: string,
  initialPayload?: ReturnType<typeof buildRunPayload> | null,
  requestedTaskId?: string | null,
): string {
  const vm = initialPayload ? buildRunViewModel(initialPayload, requestedTaskId) : null;
  const safeRunId = escapeHtml(runId);
  const initialSummary = vm?.plan?.summary || vm?.run?.summary || vm?.run?.prompt || 'Loading run details...';
  const actionsHtml = vm ? buildActionsHtml(vm.run, vm.plan) : '';
  const metaHtml = vm ? buildMetaGridHtml(vm) : '';
  const planMetaHtml = vm ? buildPlanMetaHtml(vm) : '';
  const eventsHtml = vm ? buildEventsHtml(vm.events) : '';
  const taskListHtml = vm ? buildTaskListHtml(vm.tasks, vm.selectedTaskId) : '<div class="muted" style="padding:16px;">Loading tasks…</div>';
  const inspectorHtml = vm ? buildInspectorHtml(vm) : '<div class="muted" style="padding:16px;">Waiting for selection…</div>';
  const artifactsHtml = vm ? buildArtifactsHtml(vm) : '<div class="muted" style="padding:16px;">No artifacts.</div>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Run ${safeRunId}</title>
    <style>
      ${GLOBAL_CSS}
      
      .topbar { padding: 32px 48px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 24px; }
      .topbar-main { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
      .topbar-titles h1 { margin: 0 0 8px 0; font-size: 24px; font-weight: 500; letter-spacing: -0.02em; }
      .topbar-titles .subtle { font-size: 14px; line-height: 1.5; color: var(--text-muted); max-width: 800px; }
      
      .actions { display: flex; gap: 12px; }
      button { border: none; border-radius: 8px; padding: 10px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.2s, border-color 0.2s, background 0.2s; }
      button:hover { opacity: 0.95; }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      .btn-primary { background: var(--text-main); color: var(--bg-app); }
      .btn-secondary { background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-main); }
      .btn-danger { background: #ef4444; color: white; }

      .progress-track { width: 100%; height: 6px; border-radius: 99px; background: var(--bg-surface); overflow: hidden; margin-top: 8px; }
      .progress-bar { height: 100%; background: #4ade80; transition: width 0.3s ease; }

      .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
      .meta-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
      .meta-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); font-weight: 600; }
      .meta-value { font-size: 14px; font-weight: 500; }
      
      .status-badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

      .dashboard-layout { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; padding: 32px 48px; align-items: start; }
      @media (max-width: 1200px) { .dashboard-layout { grid-template-columns: 1fr; } }
      
      .section { display: flex; flex-direction: column; gap: 16px; margin-bottom: 32px; }
      .section-header h2 { margin: 0; font-size: 16px; font-weight: 500; }
      .section-note { font-size: 13px; color: var(--text-muted); }

      .graph-shell { position: relative; background: var(--bg-app); border: 1px solid var(--border); border-radius: var(--radius); min-height: 420px; overflow: hidden; }
      .graph-shell::before { content: ''; position: absolute; inset: 0; background-image: radial-gradient(circle at center, #27272a 1px, transparent 1px); background-size: 24px 24px; opacity: 0.4; pointer-events: none; }
      .graph-toolbar { position: absolute; top: 16px; left: 16px; display: flex; gap: 8px; z-index: 2; flex-wrap: wrap; }
      .toolbar-chip { background: rgba(24,24,27,0.8); backdrop-filter: blur(8px); border: 1px solid var(--border); padding: 6px 12px; border-radius: 99px; font-size: 12px; font-weight: 500; color: var(--text-muted); }
      .graph-scroll { overflow: auto; padding: 60px 20px 20px; }
      
      .lane-label { fill: var(--text-main); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
      .lane-sub { fill: var(--text-muted); font-size: 11px; }
      .node-group { cursor: pointer; }
      .node-hitbox { fill: transparent; pointer-events: all; }
      .node-card { transition: stroke 0.15s ease, fill 0.15s ease; }
      .node-group:hover .node-card { stroke: #52525b; }
      .node-group.active .node-card { stroke-width: 1.75; }
      .node-title { fill: var(--text-main); font-size: 14px; font-weight: 600; pointer-events: none; }
      .node-subtitle { fill: var(--text-muted); font-size: 11px; font-family: monospace; pointer-events: none; }
      .node-foot { fill: var(--text-muted); font-size: 12px; pointer-events: none; }

      .kv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .task-card, .event-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
      .task-title { font-weight: 600; margin-bottom: 8px; }
      
      .chip-row { display: flex; gap: 8px; flex-wrap: wrap; }
      .chip { padding: 4px 10px; border-radius: 99px; background: var(--bg-app); border: 1px solid var(--border); font-size: 11px; color: var(--text-muted); }
      
      .task-list { display: flex; flex-direction: column; gap: 8px; }
      .task-list-item {
        display: flex;
        flex-direction: column;
        padding: 16px;
        background: var(--bg-surface);
        border: 1px solid rgba(63, 63, 70, 0.55);
        border-radius: 10px;
        transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease, box-shadow 0.16s ease;
        width: 100%;
        text-align: left;
        cursor: pointer;
        font-family: inherit;
        color: var(--text-main);
        appearance: none;
        -webkit-appearance: none;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
      }
      .task-list-item:hover {
        border-color: #52525b;
        background: linear-gradient(180deg, rgba(39,39,42,0.95), rgba(24,24,27,0.98));
        box-shadow: 0 10px 24px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.04);
        transform: translateY(-1px);
      }
      .task-list-item:focus-visible {
        outline: none;
        border-color: #71717a;
        box-shadow: 0 0 0 3px rgba(113,113,122,0.22);
      }
      .task-list-item.active {
        border-color: #a1a1aa;
        background: linear-gradient(180deg, rgba(39,39,42,1), rgba(24,24,27,1));
        box-shadow: 0 0 0 1px rgba(161,161,170,0.25), 0 14px 30px rgba(0,0,0,0.32);
        transform: translateY(-1px);
      }
      .task-list-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
      .task-list-title { font-weight: 500; font-size: 14px; color: var(--text-main); }
      .task-list-meta { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); gap: 12px; }
      
      .timeline { position: relative; display: flex; flex-direction: column; gap: 16px; }
      .timeline::before { content: ''; position: absolute; left: 7px; top: 8px; bottom: 8px; width: 2px; background: var(--border); }
      .timeline-item { position: relative; padding-left: 28px; }
      .timeline-dot { position: absolute; left: 0; top: 12px; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--border); }
      .event-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }

      .filters-row { display: flex; gap: 12px; margin-bottom: 12px; }
      .input-base { background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-main); padding: 10px 14px; border-radius: 8px; font-size: 13px; flex: 1; outline: none; }
      .input-base:focus { border-color: #52525b; }
      select.input-base { flex: 0 0 auto; padding-right: 32px; }
      textarea.input-base { min-height: 80px; resize: vertical; width: 100%; margin-bottom: 12px; }

      .diff-modal-overlay {
        display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100;
        align-items: center; justify-content: center;
      }
      .diff-modal-overlay.open { display: flex; }
      .diff-modal {
        background: var(--bg-app); border: 1px solid var(--border); border-radius: var(--radius);
        width: 90vw; max-width: 1000px; max-height: 85vh; display: flex; flex-direction: column;
      }
      .diff-modal-header {
        display: flex; justify-content: space-between; align-items: center;
        padding: 16px 24px; border-bottom: 1px solid var(--border);
      }
      .diff-modal-header h3 { margin: 0; font-size: 16px; font-weight: 500; }
      .diff-modal-body { overflow: auto; padding: 16px 24px; flex: 1; }
      .diff-modal-body pre { white-space: pre; overflow-x: auto; }
      .diff-add { color: #4ade80; }
      .diff-del { color: #f87171; }
      .diff-hunk { color: #60a5fa; font-weight: 600; }
    </style>
  </head>
  <body>
    ${buildGlobalNavHtml('/runs')}
    <div class="page-below-nav">
    <aside class="sidenav">
      <div class="sidenav-header">
        <h2>Runs</h2>
      </div>
      <input id="runs-search" class="search-box" type="text" placeholder="Search runs..." />
      <div id="runs" class="runs-list"></div>
    </aside>

    <main class="main-content">
      <header class="topbar">
        <div class="topbar-main">
          <div class="topbar-titles">
            <h1 id="hero-title">${safeText(vm?.run.projectName)} · ${safeRunId}</h1>
            <div id="hero-summary" class="subtle">${escapeHtml(initialSummary)}</div>
          </div>
          <div id="actions">${actionsHtml}</div>
        </div>
        <div>
          <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted); font-weight:600; margin-bottom:4px;">
            <span>RUN PROGRESS</span>
            <span id="progress-value">${vm ? vm.counts.progress : 0}%</span>
          </div>
          <div class="progress-track">
            <div id="progress-bar" class="progress-bar" style="width:${vm ? vm.counts.progress : 0}%;"></div>
          </div>
        </div>
        <div id="meta-grid" class="meta-grid">${metaHtml}</div>
        <div id="mode-banner" style="display:none; align-items:center; gap:10px; padding:10px 14px; border:1px solid var(--border); border-radius:8px; background:var(--bg-surface); flex-wrap:wrap;"></div>
      </header>

      <div class="dashboard-layout">
        <div class="stack">
          <section class="section">
            <div class="section-header">
              <h2>Execution Flow</h2>
              <div class="section-note">Dependency graph and live execution posture.</div>
            </div>
            <div class="graph-shell">
              <div class="graph-toolbar">
                <div class="toolbar-chip" id="graph-mode-chip">Loading phase...</div>
                <div class="toolbar-chip" id="graph-selection-chip">No selection</div>
              </div>
              <div class="graph-scroll" id="graph-scroll">
                <svg id="graph-stage" role="img" aria-label="Run task graph" viewBox="${escapeHtml(vm?.graph.viewBox || '0 0 1200 620')}" width="${escapeHtml(String(vm?.graph.width || 1200))}" height="${escapeHtml(String(vm?.graph.height || 620))}">${vm?.graph.svgInner || ''}</svg>
              </div>
            </div>
          </section>

          <section class="section">
            <div class="section-header">
              <h2>Task List</h2>
            </div>
            <div class="filters-row">
              <input id="task-search" class="input-base" type="text" placeholder="Search tasks..." />
              <select id="task-status-filter" class="input-base">
                <option value="all">All Statuses</option>
                <option value="pending">Pending</option>
                <option value="running">Running</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
              </select>
            </div>
            <div id="task-list" class="task-list">${taskListHtml}</div>
          </section>
          
          <section class="section">
            <div class="section-header"><h2>Timeline</h2></div>
            <div id="events" class="timeline">${eventsHtml}</div>
          </section>
        </div>

        <aside class="inspector">
          <section class="section">
            <div class="section-header"><h2>Selected Task</h2></div>
            <div id="task-inspector">${inspectorHtml}</div>
          </section>

          <section class="section">
            <div class="section-header"><h2>Artifacts</h2></div>
            <div id="task-artifacts">${artifactsHtml}</div>
          </section>

          <section class="section">
            <div class="section-header"><h2>Plan Details</h2></div>
            <div id="plan-meta">${planMetaHtml}</div>
            <div style="margin-top:16px;">
              <textarea id="reject-reason" class="input-base" placeholder="Reason for rejection (if applicable)..."></textarea>
            </div>
          </section>
        </aside>
      </div>
    </main>
    </div>

    <div class="diff-modal-overlay" id="diff-overlay">
      <div class="diff-modal">
        <div class="diff-modal-header">
          <h3 id="diff-title">Diff</h3>
          <button class="btn-secondary" id="diff-close" type="button" style="padding:6px 12px;">Close</button>
        </div>
        <div class="diff-modal-body"><pre id="diff-content">Loading...</pre></div>
      </div>
    </div>

    <script>
      const currentRunId = ${JSON.stringify(runId)};
      let latestPayload = ${serializeForScript(initialPayload || null)};
      let selectedTaskId = ${serializeForScript(vm?.selectedTaskId || null)};
      let taskSearch = '';
      let taskStatusFilter = 'all';

      const statusColors = { completed: '#4ade80', completed_with_warnings: '#f59e0b', succeeded: '#4ade80', awaiting_plan_approval: '#facc15', pending: '#facc15', failed: '#f87171', blocked: '#f87171', plan_rejected: '#f87171', running: '#60a5fa', healing: '#60a5fa', cancelled: '#9ca3af' };
      
      function safe(v) { return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
      function truncate(v, m) { const s=String(v||''); return s.length>m ? s.slice(0,m-1)+'…' : s; }
      function formatDate(v) { return v ? new Date(v).toLocaleString() : '—'; }
      function statusBadge(s) { const c = statusColors[s]||'#d1d5db'; return \`<span class="status-badge" style="background:\${c}15;color:\${c};border:1px solid \${c}30;">\${safe(s.replaceAll('_',' '))}</span>\`; }

      let allRuns = [];
      function renderRunsList(items) {
        const container = document.getElementById('runs');
        if (!items.length) { container.innerHTML = '<div class="muted" style="font-size:12px; padding:12px;">No runs found.</div>'; return; }
        container.innerHTML = items.map(item => {
          const color = statusColors[item.run.status] || '#d1d5db';
          const isActive = item.run.id === currentRunId ? ' active' : '';
          return \`<a class="run-nav-item\${isActive}" href="/runs/\${encodeURIComponent(item.run.id)}">
            <div class="run-nav-title">\${safe(item.run.projectName)}</div>
            <div class="run-nav-meta">
              <div class="run-nav-status"><div class="status-dot" style="background:\${color}"></div><span>\${safe(item.run.status.replaceAll('_',' '))}</span></div>
              <span>\${item.taskCounts?.progress || 0}%</span>
            </div>
          </a>\`;
        }).join('');
      }

      async function loadSidenavRuns() {
        const res = await fetch('/api/runs');
        allRuns = await res.json();
        const search = document.getElementById('runs-search').value.toLowerCase().trim();
        const filtered = allRuns.filter(i => !search || [i.run.projectName, i.run.id].join(' ').toLowerCase().includes(search));
        renderRunsList(filtered);
      }
      document.getElementById('runs-search').addEventListener('input', loadSidenavRuns);

      function normalizeTasks(run, plan, tasks) {
        if (tasks && tasks.length) return tasks.slice().sort((l,r)=>l.orderIndex-r.orderIndex).map(t=>({...t, writeScope: t.writeScope||['.'], dependencies: t.dependencies||[]}));
        const drafts = plan?.rawPlan?.tasks || [];
        const t2id = {}; drafts.forEach((t,i) => t2id[t.title]='draft-'+i);
        return drafts.map((t,i) => ({
          id: t2id[t.title]||'draft-'+i, runId: run.id, parentTaskId: null, title: t.title, prompt: t.prompt, role: t.role||'executor', kind: t.kind||'implement',
          status: run.status==='plan_rejected'?'blocked':'pending', writeScope: t.writeScope||['.'], dependencies: (t.dependencies||[]).map(d=>t2id[d]).filter(Boolean),
          attempts: 0, branchName: null, worktreePath: null, commitSha: null, commitMessage: null, outputSummary: t.rationale||null, validationSummary: null,
          orderIndex: i, createdAt: run.createdAt, updatedAt: run.updatedAt, startedAt: null, finishedAt: null, planOnly: true
        }));
      }

      function buildLevels(tasks) {
        const byId = new Map(tasks.map(t => [t.id, t]));
        const memo = new Map();
        function compute(id, trail) {
          if(memo.has(id)) return memo.get(id);
          if(trail.has(id)) return 0;
          const t = byId.get(id); if(!t) return 0;
          trail.add(id);
          const deps = (t.dependencies||[]).filter(d => byId.has(d));
          const lvl = deps.length ? Math.max(...deps.map(d => compute(d, trail))) + 1 : 0;
          trail.delete(id); memo.set(id, lvl); return lvl;
        }
        tasks.forEach(t => compute(t.id, new Set()));
        const lvls = [];
        tasks.forEach(t => { const l = memo.get(t.id)||0; if(!lvls[l]) lvls[l]=[]; lvls[l].push(t); });
        lvls.forEach(c => c.sort((l,r)=>l.orderIndex-r.orderIndex));
        return lvls.filter(Boolean);
      }

      function getCounts(tasks) {
        const c = { total: tasks.length, pending:0, running:0, succeeded:0, failed:0, blocked:0, skipped:0, done:0, progress:0 };
        tasks.forEach(t => { if(c[t.status]!==undefined) c[t.status]++; });
        c.done = c.succeeded + c.failed + c.blocked + c.skipped;
        c.progress = c.total ? Math.round((c.done/c.total)*100) : 0;
        return c;
      }

      function syncUrl() {
        const u = new URL(window.location.href);
        if(selectedTaskId) u.searchParams.set('task', selectedTaskId); else u.searchParams.delete('task');
        window.history.replaceState({}, '', u.toString());
      }

      function scrollSelectedNodeIntoView() {
        const node = document.querySelector('.node-group.active');
        if (node) {
          node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        }
      }

      const MODE_META = {
        interactive: { label: 'Interactive Autonomous', color: '#60a5fa', desc: 'Planner proposes tasks; you approve before execution.' },
        nightly: { label: 'Nightly Autonomous', color: '#a78bfa', desc: 'Planner and executor run end-to-end without approval gates.' },
        pair: { label: 'Pair', color: '#4ade80', desc: 'Single iteration, no planner.' },
        auto: { label: 'Auto', color: '#e4e4e7', desc: 'Legacy mode.' }
      };
      function modeBadge(mode){
        const m = MODE_META[mode] || { label: mode, color: '#d1d5db', desc: '' };
        return \`<span class="status-badge" title="\${safe(m.desc)}" style="background:\${m.color}15;color:\${m.color};border:1px solid \${m.color}40;display:inline-flex;align-items:center;gap:6px;"><span style="width:5px;height:5px;border-radius:50%;background:\${m.color};"></span>\${safe(m.label)}</span>\`;
      }

      function updateTopbar(run, plan, counts) {
        document.getElementById('hero-title').textContent = run.projectName + ' · ' + run.id;
        document.getElementById('hero-summary').textContent = plan?.summary || run.summary || run.prompt;
        document.getElementById('progress-value').textContent = counts.progress + '%';
        document.getElementById('progress-bar').style.width = counts.progress + '%';

        const cards = [
          ['Status', statusBadge(run.status)], ['Mode', modeBadge(run.mode)], ['Branch', safe(run.branchName)],
          ['Plan', plan ? statusBadge(plan.status) : '<span class="muted">Missing</span>'],
          ['Progress', counts.progress+'%'], ['Tasks', counts.total], ['Running', counts.running], ['Failed', counts.failed]
        ];
        document.getElementById('meta-grid').innerHTML = cards.map(c => \`<div class="meta-card"><div class="meta-label">\${c[0]}</div><div class="meta-value">\${c[1]}</div></div>\`).join('');

        // Mode banner: only show explicit guidance for interactive (awaiting approval) and nightly (auto-approve warning).
        const bannerEl = document.getElementById('mode-banner');
        if (bannerEl) {
          const m = MODE_META[run.mode];
          if (m && run.status !== 'completed' && run.status !== 'completed_with_warnings' && run.status !== 'failed' && run.status !== 'cancelled') {
            bannerEl.style.display = 'flex';
            bannerEl.style.borderColor = m.color + '40';
            bannerEl.style.background = m.color + '10';
            bannerEl.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:' + m.color + ';flex-shrink:0;"></span><span style="color:' + m.color + ';font-weight:500;font-size:13px;letter-spacing:0.01em;">' + safe(m.label) + '</span><span style="color:var(--text-muted);font-size:12px;">' + safe(m.desc) + '</span>';
          } else {
            bannerEl.style.display = 'none';
          }
        }

        const actions = document.getElementById('actions');
        let actHtml = '';
        if (run.status === 'awaiting_plan_approval' && plan?.status === 'proposed') {
          actHtml = \`<button class="btn-primary" id="approve-plan" type="button">Approve Plan</button> <button class="btn-danger" id="reject-plan" type="button">Reject</button>\`;
        } else if (run.status === 'running' || run.status === 'healing') {
          actHtml = \`<button class="btn-secondary" id="cancel-run" type="button">Cancel Run</button>\`;
        } else if (run.status === 'failed' || run.status === 'completed_with_warnings') {
          actHtml = \`<button class="btn-secondary" id="rerun-failed" type="button">Re-run Failed Tasks</button> <button class="btn-secondary" id="view-diff" type="button">View Diff</button> <button class="btn-primary" id="create-pr" type="button">Create PR</button> <button class="btn-secondary" id="run-local" type="button">▶ Run Locally</button>\`;
        } else if (run.status === 'completed') {
          actHtml = \`<button class="btn-secondary" id="view-diff" type="button">View Diff</button> <button class="btn-primary" id="create-pr" type="button">Create PR</button> <button class="btn-secondary" id="run-local" type="button">▶ Run Locally</button>\`;
        }
        actions.innerHTML = actHtml;

        const bind = (id, fn) => {
          const el = document.getElementById(id);
          if(el) el.onclick = async () => {
            el.disabled = true;
            await fn();
            await loadRunData();
          };
        };

        bind('approve-plan', () => fetch('/api/runs/'+currentRunId+'/approve-plan', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({})
        }));

        bind('reject-plan', () => fetch('/api/runs/'+currentRunId+'/reject-plan', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({reason: document.getElementById('reject-reason').value})
        }));

        bind('cancel-run', () => fetch('/api/runs/'+currentRunId+'/cancel', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({})
        }));

        bind('rerun-failed', () => fetch('/api/runs/'+currentRunId+'/rerun-failed', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({})
        }));

        const prBtn = document.getElementById('create-pr');
        if(prBtn) prBtn.onclick = async () => {
          prBtn.disabled = true;
          const original = prBtn.textContent;
          prBtn.textContent = 'Opening PR...';
          try {
            const r = await fetch('/api/runs/'+currentRunId+'/create-pr', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
            const data = await r.json();
            if (r.ok && data.prUrl) { prBtn.textContent = 'PR Opened ✓'; window.open(data.prUrl, '_blank'); }
            else { prBtn.textContent = original; alert('PR failed: ' + (data.error || 'unknown error')); }
          } catch(e) { prBtn.textContent = original; alert('PR request failed.'); }
          await loadRunData();
        };

        const runLocalBtn = document.getElementById('run-local');
        if(runLocalBtn) runLocalBtn.onclick = async () => {
          runLocalBtn.disabled = true;
          const original = runLocalBtn.textContent;
          runLocalBtn.textContent = 'Starting (FE+BE)...';
          try {
            const r = await fetch('/api/runs/'+currentRunId+'/run-local', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
            const data = await r.json();
            if (r.ok) { runLocalBtn.textContent = 'Starting — watch events for URL'; }
            else { runLocalBtn.textContent = original; runLocalBtn.disabled = false; alert('Failed to start: ' + (data.error || 'unknown error')); }
          } catch(e) { runLocalBtn.textContent = original; runLocalBtn.disabled = false; alert('Run-local request failed.'); }
          await loadRunData();
        };

        const diffBtn = document.getElementById('view-diff');
        if(diffBtn) diffBtn.onclick = async () => {
          const overlay = document.getElementById('diff-overlay');
          const content = document.getElementById('diff-content');
          const title = document.getElementById('diff-title');
          overlay.classList.add('open');
          content.textContent = 'Loading diff...';
          try {
            const r = await fetch('/api/runs/'+currentRunId+'/diff');
            const data = await r.json();
            title.textContent = 'Diff: ' + (data.branchName || currentRunId);
            content.innerHTML = colorDiff(data.diff || 'No diff available');
          } catch(e) { content.textContent = 'Error loading diff.'; }
        };
      }

      function renderGraph(tasks, run) {
        const stage = document.getElementById('graph-stage');
        if (!tasks.length) {
          stage.innerHTML = '<text x="100" y="180" fill="var(--text-muted)">No tasks generated yet.</text>';
          return;
        }

        const levels = buildLevels(tasks);
        const nw = 280, nh = 110, cg = 120, rg = 140, mx = 60, my = 80;
        const pos = new Map(); let maxR = 1;
        levels.forEach((col, ci) => { maxR = Math.max(maxR, col.length); col.forEach((t, ri) => pos.set(t.id, {x: mx+ci*(nw+cg), y: my+ri*rg})); });
        
        const w = mx*2 + levels.length*nw + Math.max(0, levels.length-1)*cg;
        const h = my + maxR*rg + 90;
        stage.setAttribute('viewBox', \`0 0 \${w} \${h}\`);
        stage.setAttribute('width', w);
        stage.setAttribute('height', h);

        const lanes = levels.map((c, i) => \`<text x="\${mx+i*(nw+cg)}" y="36" class="lane-label">Phase \${i+1}</text><text x="\${mx+i*(nw+cg)}" y="56" class="lane-sub">\${c.length} node(s)</text>\`).join('');
        const edges = tasks.flatMap(t => {
          const tgt = pos.get(t.id); if(!tgt) return [];
          return (t.dependencies||[]).map(d => {
            const src = pos.get(d); if(!src) return '';
            const sx=src.x+nw, sy=src.y+nh/2, ex=tgt.x, ey=tgt.y+nh/2, cv=Math.max(40, (ex-sx)/2);
            return \`<path class="edge" stroke="#3f3f46" d="M \${sx} \${sy} C \${sx+cv} \${sy}, \${ex-cv} \${ey}, \${ex} \${ey}" />\`;
          });
        }).join('');

        const nodes = tasks.map(t => {
          const p = pos.get(t.id), c = statusColors[t.status]||'#d1d5db', act = selectedTaskId===t.id;
          const stroke = act ? c : '#3f3f46';
          const glow = act ? \`drop-shadow(0 0 10px \${c}40)\` : 'none';
          return \`<g class="node-group\${act?' active':''}" data-task-id="\${safe(t.id)}" transform="translate(\${p.x} \${p.y})" style="filter:\${glow}">
            <rect class="node-hitbox" x="-8" y="-8" rx="16" ry="16" width="\${nw+16}" height="\${nh+16}" />
            <rect class="node-card" x="0" y="0" rx="12" ry="12" width="\${nw}" height="\${nh}" fill="#18181b" stroke="\${stroke}" stroke-width="1.5"/>
            <rect x="16" y="16" rx="6" ry="6" width="68" height="24" fill="\${c}15" stroke="\${c}30" />
            <text x="26" y="32" class="node-subtitle" fill="\${c}">\${safe(t.status.toUpperCase())}</text>
            <circle cx="250" cy="28" r="4" fill="\${c}" />
            <text x="16" y="64" class="node-title">\${safe(truncate(t.title, 28))}</text>
            <text x="16" y="84" class="node-subtitle">scope: \${safe(truncate((t.writeScope||['.']).join(', '), 26))}</text>
            <text x="16" y="100" class="node-foot">\${safe(truncate(t.outputSummary || t.validationSummary || t.prompt || '', 44))}</text>
          </g>\`;
        }).join('');

        stage.innerHTML = lanes + edges + nodes;
        const selT = tasks.find(t=>t.id===selectedTaskId);
        document.getElementById('graph-mode-chip').textContent = run.status.replaceAll('_',' ');
        document.getElementById('graph-selection-chip').textContent = selT ? 'Inspecting: '+selT.title : 'No selection';

        stage.querySelectorAll('.node-group').forEach(n => {
          n.addEventListener('click', (event) => {
            event.preventDefault();
            selectedTaskId = n.getAttribute('data-task-id');
            syncUrl();
            renderAll();
            scrollSelectedNodeIntoView();
          });
        });
      }

      function renderLists(tasks, events, artifacts) {
        const visibleT = tasks.filter(t => {
          const s = !taskSearch || [t.title, t.prompt, t.outputSummary].join(' ').toLowerCase().includes(taskSearch);
          const f = taskStatusFilter === 'all' || t.status === taskStatusFilter;
          return s && f;
        });

        document.getElementById('task-list').innerHTML = visibleT.length ? visibleT.map(t => {
          const act = selectedTaskId === t.id ? ' active' : '';
          return \`<button type="button" class="task-list-item\${act}" data-tl-id="\${safe(t.id)}">
            <div class="task-list-top"><div class="task-list-title">\${safe(t.title)}</div>\${statusBadge(t.status)}</div>
            <div class="chip-row" style="margin-top:8px;"><span class="chip">\${safe(t.kind||'implement')}</span><span class="chip">attempts \${t.attempts||0}</span></div>
            <div class="task-list-meta" style="margin-top:12px;"><span>scope: \${safe((t.writeScope||['.']).join(', '))}</span><span>\${t.dependencies?.length ? t.dependencies.length + ' deps' : 'no deps'}</span></div>
          </button>\`;
        }).join('') : '<div class="muted">No tasks match.</div>';

        document.querySelectorAll('[data-tl-id]').forEach(b => b.addEventListener('click', () => {
          selectedTaskId = b.getAttribute('data-tl-id');
          syncUrl();
          renderAll();
        }));

        document.getElementById('events').innerHTML = events.length ? events.slice().reverse().map((e, idx) => {
          const isThinking = e.type === 'agent.thinking';
          const c = isThinking ? '#a78bfa' : e.level==='error'?'#f87171':e.level==='warning'?'#facc15':'#60a5fa';
          const thinkingId = 'think-' + idx;
          if (isThinking) {
            const body = safe(e.message).replace(/\\n/g, '<br>');
            return \`<div class="timeline-item"><div class="timeline-dot" style="background:\${c}; box-shadow:0 0 0 4px #09090b"></div>
              <div class="event-card" style="border-color:#a78bfa30;">
                <div class="event-top" style="cursor:pointer;" onclick="var el=document.getElementById('\${thinkingId}'); el.style.display=el.style.display==='block'?'none':'block'; this.querySelector('.thinking-caret').textContent=el.style.display==='block'?'Hide':'Show';">
                  <strong style="font-size:12px;color:#a78bfa;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Reasoning</strong>
                  <span class="muted" style="font-size:11px">\${formatDate(e.createdAt)} · <span class="thinking-caret">Show</span></span>
                </div>
                <div id="\${thinkingId}" style="display:none; font-size:12px; margin-top:8px; color:var(--text-muted); max-height:360px; overflow-y:auto; padding:10px 12px; background:var(--bg-app); border-radius:6px; border:1px solid #2a2a2d; white-space:pre-wrap; font-family:ui-monospace, monospace; line-height:1.6;">\${body}</div>
              </div></div>\`;
          }
          return \`<div class="timeline-item"><div class="timeline-dot" style="background:\${c}; box-shadow:0 0 0 4px #09090b"></div>
            <div class="event-card"><div class="event-top"><strong style="font-size:13px">\${safe(e.type)}</strong><span class="muted" style="font-size:11px">\${formatDate(e.createdAt)}</span></div>
            <div style="font-size:13px; margin-top:6px; color:var(--text-muted)">\${safe(e.message)}</div></div></div>\`;
        }).join('') : '<div class="muted">No events.</div>';

        const t = tasks.find(c => c.id === selectedTaskId);
        if(!t) {
          document.getElementById('task-inspector').innerHTML = '<div class="muted">Select a task.</div>';
          document.getElementById('task-artifacts').innerHTML = '<div class="muted">Select a task.</div>';
          return;
        }
        
        document.getElementById('task-inspector').innerHTML = \`<div style="display:flex; flex-direction:column; gap:16px;">
          <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;"><div style="font-weight:600;">\${safe(t.title)}</div>\${statusBadge(t.status)}</div>
          <div class="kv-grid">
            <div class="meta-card"><div class="meta-label">Scope</div><div class="meta-value" style="font-size:12px; font-weight:normal">\${safe((t.writeScope||['.']).join(', '))}</div></div>
            <div class="meta-card"><div class="meta-label">Dependencies</div><div class="meta-value" style="font-size:12px; font-weight:normal">\${t.dependencies.length?t.dependencies.length:'None'}</div></div>
          </div>
          <div class="task-card"><div class="meta-label">Summary</div><pre>\${safe(t.outputSummary || t.prompt || 'No summary.')}</pre></div>
        </div>\`;

        const arts = artifacts.filter(a => a.taskId === t.id);
        document.getElementById('task-artifacts').innerHTML = arts.length ? arts.map(a => \`<div class="task-card" style="margin-bottom:8px;">
          <div style="display:flex; justify-content:space-between; margin-bottom:8px; font-size:12px; gap:12px;"><strong>\${safe(a.type)}</strong><span class="muted">\${formatDate(a.createdAt)}</span></div>
          <pre>\${safe(a.content ? a.content.slice(0,800) : 'binary')}</pre></div>\`).join('') : '<div class="muted">No artifacts stored.</div>';
      }

      function renderAll() {
        if(!latestPayload) return;
        const run = latestPayload.run, plan = latestPayload.plan;
        const tasks = normalizeTasks(run, plan, latestPayload.tasks||[]);
        const events = latestPayload.events||[], artifacts = latestPayload.artifacts||[];
        const counts = getCounts(tasks);

        updateTopbar(run, plan, counts);
        renderGraph(tasks, run);
        renderLists(tasks, events, artifacts);
      }

      async function loadRunData() {
        try {
          const res = await fetch('/api/runs/'+currentRunId);
          if(!res.ok) return;
          latestPayload = await res.json();
          renderAll();
        } catch(e) { console.error(e); }
      }

      function colorDiff(raw) {
        return safe(raw).split('\\n').map(line => {
          if(line.startsWith('+') && !line.startsWith('+++')) return '<span class="diff-add">'+line+'</span>';
          if(line.startsWith('-') && !line.startsWith('---')) return '<span class="diff-del">'+line+'</span>';
          if(line.startsWith('@@')) return '<span class="diff-hunk">'+line+'</span>';
          return line;
        }).join('\\n');
      }

      document.getElementById('diff-close').onclick = () => document.getElementById('diff-overlay').classList.remove('open');
      document.getElementById('diff-overlay').onclick = (e) => { if(e.target.id==='diff-overlay') e.target.classList.remove('open'); };

      document.getElementById('task-search').addEventListener('input', e => { taskSearch = e.target.value.toLowerCase(); renderAll(); });
      document.getElementById('task-status-filter').addEventListener('change', e => { taskStatusFilter = e.target.value; renderAll(); });

      loadSidenavRuns();
      setInterval(loadSidenavRuns, 5000);

      if(latestPayload) {
        renderAll();
      } else {
        loadRunData();
      }

      setInterval(loadRunData, 4000);
    </script>
  </body>
</html>`;
}

/* ── Analytics Dashboard Page ── */

function buildGlobalNavHtml(active: string): string {
  const items = [
    { href: '/', label: 'Home', id: '/' },
    { href: '/analytics', label: 'Analytics', id: '/analytics' },
    { href: '/knowledge', label: 'Knowledge', id: '/knowledge' },
    { href: '/learning', label: 'Learning', id: '/learning' },
    { href: '/settings', label: 'Settings', id: '/settings' },
  ];
  return `<nav class="global-nav">
    <a href="/" class="brand"><span class="brand-dot"></span>Unity</a>
    ${items.map((i) => `<a href="${i.href}" class="gn-link${active === i.id ? ' active' : ''}">${i.label}</a>`).join('')}
    <span class="nav-spacer"></span>
  </nav>`;
}

function shellPage(title: string, activePath: string, bodyHtml: string, scriptHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Unity · ${escapeHtml(title)}</title>
<style>
${GLOBAL_CSS}
.page-body { flex:1; overflow-y:auto; padding:32px 48px; }
.page-title { font-size:24px; font-weight:500; margin:0 0 8px; }
.page-subtitle { color:var(--text-muted); font-size:14px; margin:0 0 32px; }
.card-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px,1fr)); gap:16px; margin-bottom:32px; }
.card { background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px; }
.card-label { font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); font-weight:600; margin-bottom:8px; }
.card-value { font-size:28px; font-weight:300; }
.card-sub { font-size:12px; color:var(--text-muted); margin-top:4px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; }
td { padding:10px 12px; border-bottom:1px solid #1e1e21; }
.bar-track { height:8px; background:var(--bg-app); border-radius:99px; overflow:hidden; }
.bar-fill { height:100%; border-radius:99px; transition:width 0.3s; }
.section-title { font-size:16px; font-weight:500; margin:0 0 16px; }
.section-gap { margin-top:32px; }
.two-col { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
@media(max-width:1000px){ .two-col { grid-template-columns:1fr; } }
</style></head><body>
${buildGlobalNavHtml(activePath)}
<main class="page-body">${bodyHtml}</main>
<script>${scriptHtml}</script>
</body></html>`;
}

function buildAnalyticsPage(): string {
  return shellPage('Analytics', '/analytics', `
    <h1 class="page-title">Analytics Dashboard</h1>
    <p class="page-subtitle">Cost, gate health, edit reliability, and learning effectiveness across all runs.</p>

    <div class="card-grid" id="cost-cards"></div>

    <div class="two-col section-gap">
      <div>
        <h2 class="section-title">Gate Health</h2>
        <table id="gate-table"><thead><tr><th>Gate</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Pass Rate</th></tr></thead><tbody></tbody></table>
      </div>
      <div>
        <h2 class="section-title">Edit Reliability</h2>
        <div class="card-grid" style="grid-template-columns:1fr 1fr;" id="edit-cards"></div>
      </div>
    </div>

    <div class="two-col section-gap">
      <div>
        <h2 class="section-title">Learning Effectiveness</h2>
        <div class="card-grid" style="grid-template-columns:1fr 1fr;" id="learning-cards"></div>
      </div>
      <div>
        <h2 class="section-title">Model Cost Breakdown</h2>
        <table id="model-table"><thead><tr><th>Model</th><th>Tokens</th><th>Est. Cost</th><th>Share</th></tr></thead><tbody></tbody></table>
      </div>
    </div>

    <h2 class="section-title section-gap">Recent Run Costs</h2>
    <table id="run-cost-table"><thead><tr><th>Run</th><th>Project</th><th>Status</th><th>Tasks</th><th>Tokens</th><th>Est. Cost</th><th>When</th></tr></thead><tbody></tbody></table>

    <h2 class="section-title section-gap">Hot Files</h2>
    <table id="hot-table"><thead><tr><th>File</th><th>Changes</th><th>Failures</th><th>Fragility</th></tr></thead><tbody></tbody></table>
  `, `
    function safe(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');}
    function pct(n,d){return d>0?(n/d*100).toFixed(1)+'%':'—';}
    function bar(ratio,color){return '<div class="bar-track" style="width:100px;display:inline-block;vertical-align:middle;"><div class="bar-fill" style="width:'+Math.round(Math.min(ratio,1)*100)+'%;background:'+color+'"></div></div>';}
    var statusColors={completed:'#4ade80',completed_with_warnings:'#f59e0b',failed:'#f87171',running:'#60a5fa',awaiting_plan_approval:'#facc15',cancelled:'#9ca3af'};
    function badge(s){var c=statusColors[s]||'#d1d5db';return '<span style="display:inline-flex;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:'+c+'15;color:'+c+';border:1px solid '+c+'30;">'+safe(s.replaceAll('_',' '))+'</span>';}
    function ago(d){if(!d)return'—';var ms=Date.now()-new Date(d).getTime(),m=Math.round(ms/60000);if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<24)return h+'h ago';return Math.round(h/24)+'d ago';}

    async function load(){
      const [statsR,gatesR,editsR,learningR,hotR,runsR]=await Promise.all([
        fetch('/api/telemetry/stats'),fetch('/api/telemetry/gate-stats'),
        fetch('/api/telemetry/edit-metrics'),fetch('/api/learning/stats'),
        fetch('/api/knowledge/hot-files'),fetch('/api/runs')
      ]);
      const stats=await statsR.json(),gates=await gatesR.json(),edits=await editsR.json(),learning=await learningR.json(),hot=await hotR.json(),runs=await runsR.json();

      document.getElementById('cost-cards').innerHTML=[
        ['Total Runs',stats.totalRuns,'#e4e4e7'],['Total Tokens',(stats.totalTokens||0).toLocaleString(),'#60a5fa'],
        ['Total Cost','$'+(stats.totalCostUsd||0).toFixed(2),'#f59e0b'],['Avg Tokens/Run',(stats.avgTokensPerRun||0).toLocaleString(),'#a78bfa'],
        ['Success Rate',pct(Math.round((stats.successRate||0)*stats.totalRuns),stats.totalRuns||1),'#4ade80']
      ].map(function(c){return '<div class="card"><div class="card-label">'+c[0]+'</div><div class="card-value" style="color:'+c[2]+'">'+c[1]+'</div></div>';}).join('');

      var gtb=document.querySelector('#gate-table tbody');
      gtb.innerHTML=gates.length?gates.map(function(g){var rate=g.total>0?g.passed/g.total:0;return '<tr><td style="font-weight:500">'+safe(g.gate)+'</td><td>'+g.passed+'</td><td style="color:#f87171">'+g.failed+'</td><td style="color:var(--text-muted)">'+g.skipped+'</td><td>'+bar(rate,'#4ade80')+' <span style="font-size:12px;color:var(--text-muted);margin-left:4px">'+pct(g.passed,g.total)+'</span></td></tr>';}).join(''):'<tr><td colspan="5" class="muted">No gate data yet.</td></tr>';

      document.getElementById('edit-cards').innerHTML=[
        ['Applied',edits.applied],['Failed',edits.failed],
        ['Fuzzy Saves',edits.fuzzyMatches],['Success Rate',pct(edits.applied,edits.total)]
      ].map(function(c){return '<div class="card"><div class="card-label">'+c[0]+'</div><div class="card-value">'+c[1]+'</div></div>';}).join('');

      document.getElementById('learning-cards').innerHTML=[
        ['Patterns',learning.totalPatterns],['Effective',learning.effectivePatterns],
        ['Applications',learning.totalApplications],['Success Rate',(learning.overallSuccessRate*100).toFixed(1)+'%']
      ].map(function(c){return '<div class="card"><div class="card-label">'+c[0]+'</div><div class="card-value">'+c[1]+'</div></div>';}).join('');

      // Model cost breakdown — aggregate from per-run telemetry
      var modelMap={};
      var costPromises=runs.slice(0,20).map(function(item){
        return fetch('/api/runs/'+encodeURIComponent(item.run.id)+'/cost').then(function(r){return r.json();});
      });
      var costData=await Promise.all(costPromises);
      costData.forEach(function(cd){
        if(!cd.summary||!cd.summary.modelBreakdown)return;
        cd.summary.modelBreakdown.forEach(function(mb){
          if(!modelMap[mb.model])modelMap[mb.model]={tokens:0,cost:0};
          modelMap[mb.model].tokens+=mb.tokens;
          modelMap[mb.model].cost+=mb.costUsd;
        });
      });
      var models=Object.entries(modelMap).sort(function(a,b){return b[1].tokens-a[1].tokens;});
      var totalModelTokens=models.reduce(function(s,m){return s+m[1].tokens;},0)||1;
      var mtb=document.querySelector('#model-table tbody');
      mtb.innerHTML=models.length?models.map(function(m){var share=m[1].tokens/totalModelTokens;return '<tr><td style="font-family:monospace;font-size:12px;font-weight:500">'+safe(m[0])+'</td><td>'+m[1].tokens.toLocaleString()+'</td><td>$'+m[1].cost.toFixed(2)+'</td><td>'+bar(share,'#a78bfa')+' <span style="font-size:12px;color:var(--text-muted);margin-left:4px">'+(share*100).toFixed(0)+'%</span></td></tr>';}).join(''):'<tr><td colspan="4" class="muted">No model data yet.</td></tr>';

      // Per-run cost table
      var rctb=document.querySelector('#run-cost-table tbody');
      rctb.innerHTML=runs.slice(0,30).map(function(item,i){
        var r=item.run,cd=costData[i]||{},cs=cd.summary||{};
        return '<tr style="cursor:pointer" onclick="location.href=\\'/runs/'+encodeURIComponent(r.id)+'\\'">'
          +'<td style="font-family:monospace;font-size:12px">'+safe(r.id.slice(0,12))+'</td>'
          +'<td style="font-weight:500">'+safe(r.projectName)+'</td>'
          +'<td>'+badge(r.status)+'</td>'
          +'<td>'+(cs.taskCount||item.taskCounts?.total||0)+'</td>'
          +'<td>'+(cs.totalTokens||0).toLocaleString()+'</td>'
          +'<td style="color:#f59e0b">$'+(cs.totalCostUsd||0).toFixed(2)+'</td>'
          +'<td style="color:var(--text-muted);font-size:12px">'+ago(r.createdAt)+'</td>'
          +'</tr>';
      }).join('');

      var htb=document.querySelector('#hot-table tbody');
      htb.innerHTML=hot.length?hot.map(function(f){var frag=f.changeCount>0?f.failureCount/f.changeCount:0;return '<tr><td style="font-family:monospace;font-size:12px">'+safe(f.path)+'</td><td>'+f.changeCount+'</td><td style="color:#f87171">'+f.failureCount+'</td><td>'+bar(frag,'#f59e0b')+' <span style="font-size:12px;color:var(--text-muted);margin-left:4px">'+(frag*100).toFixed(0)+'%</span></td></tr>';}).join(''):'<tr><td colspan="4" class="muted">No file change data yet.</td></tr>';
    }
    load();
  `);
}

function buildKnowledgePage(): string {
  return shellPage('Knowledge', '/knowledge', `
    <h1 class="page-title">Knowledge Graph</h1>
    <p class="page-subtitle">Module boundaries, API surface, architecture decisions, and file change attribution.</p>

    <div class="card-grid" id="kg-summary"></div>

    <h2 class="section-title section-gap">Modules</h2>
    <table id="mod-table"><thead><tr><th>Module</th><th>Type</th><th>Dependencies</th><th>Dependents</th><th>Changes</th><th>Failures</th><th>Fragility</th></tr></thead><tbody></tbody></table>

    <div class="two-col section-gap">
      <div>
        <h2 class="section-title">Fragile Areas</h2>
        <div id="fragile-list"></div>
      </div>
      <div>
        <h2 class="section-title">API Endpoints</h2>
        <table id="api-table"><thead><tr><th>Method</th><th>Path</th><th>Source File</th></tr></thead><tbody></tbody></table>
      </div>
    </div>

    <h2 class="section-title section-gap">Architecture Decisions</h2>
    <div id="decisions"></div>

    <h2 class="section-title section-gap">Recent File Changes</h2>
    <table id="changes-table"><thead><tr><th>File</th><th>Run</th><th>Task</th><th>Type</th><th>Gate</th><th>Date</th></tr></thead><tbody></tbody></table>
  `, `
    function safe(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');}
    function bar(ratio,color){return '<div style="height:8px;background:var(--bg-app);border-radius:99px;overflow:hidden;width:80px;display:inline-block;vertical-align:middle;"><div style="height:100%;border-radius:99px;width:'+Math.round(Math.min(ratio,1)*100)+'%;background:'+color+'"></div></div>';}
    function methodColor(m){return{GET:'#4ade80',POST:'#60a5fa',PUT:'#f59e0b',DELETE:'#f87171',PATCH:'#a78bfa'}[m]||'var(--text-muted)';}

    async function load(){
      const [modsR,fragileR,decisionsR,changesR,apiR]=await Promise.all([
        fetch('/api/knowledge/modules'),fetch('/api/knowledge/fragile'),
        fetch('/api/knowledge/decisions'),fetch('/api/knowledge/file-changes'),
        fetch('/api/knowledge/api-endpoints')
      ]);
      const mods=await modsR.json(),fragile=await fragileR.json(),decisions=await decisionsR.json(),changes=await changesR.json(),apis=await apiR.json();

      // Summary cards
      document.getElementById('kg-summary').innerHTML=[
        ['Modules',mods.length,'#60a5fa'],['API Endpoints',apis.length,'#4ade80'],
        ['Decisions',decisions.length,'#a78bfa'],['File Changes',changes.length,'#f59e0b'],
        ['Fragile Areas',fragile.length,'#f87171']
      ].map(function(c){return '<div class="card"><div class="card-label">'+c[0]+'</div><div class="card-value" style="color:'+c[2]+'">'+c[1]+'</div></div>';}).join('');

      // Modules table
      document.querySelector('#mod-table tbody').innerHTML=mods.length?mods.map(function(m){
        var deps=(m.dependencies||[]).length,depts=(m.dependents||[]).length;
        var frag=m.changeFrequency>0?m.failureFrequency/m.changeFrequency:0;
        var fragColor=frag>0.5?'#f87171':frag>0.2?'#f59e0b':'#4ade80';
        return '<tr><td style="font-family:monospace;font-size:12px;font-weight:500">'+safe(m.modulePath)+'</td><td>'+safe(m.moduleType)+'</td><td>'+deps+'</td><td>'+depts+'</td><td>'+m.changeFrequency+'</td><td style="color:#f87171">'+(m.failureFrequency||0)+'</td><td>'+bar(frag,fragColor)+' <span style="font-size:12px;color:var(--text-muted);margin-left:4px">'+(frag*100).toFixed(0)+'%</span></td></tr>';
      }).join(''):'<tr><td colspan="7" class="muted">No modules tracked yet. Run a project scan first.</td></tr>';

      // Fragile areas
      document.getElementById('fragile-list').innerHTML=fragile.length?fragile.map(function(f){
        var score=Math.min(f.fragilityScore||0,1);
        var color=score>0.5?'#f87171':score>0.2?'#f59e0b':'#4ade80';
        return '<div class="card" style="margin-bottom:8px;display:flex;align-items:center;gap:16px;padding:14px 16px;"><div style="flex:1;font-family:monospace;font-size:12px;font-weight:500">'+safe(f.modulePath)+'</div><div>'+bar(score,color)+'</div><div style="font-size:13px;font-weight:500;min-width:40px;text-align:right;color:'+color+'">'+(score*100).toFixed(0)+'%</div></div>';
      }).join(''):'<div class="muted" style="padding:16px;">No fragile areas detected.</div>';

      // API endpoints
      document.querySelector('#api-table tbody').innerHTML=apis.length?apis.map(function(a){
        return '<tr><td style="font-weight:600;color:'+methodColor(a.method)+'">'+safe(a.method)+'</td><td style="font-family:monospace;font-size:12px">'+safe(a.path)+'</td><td style="font-family:monospace;font-size:12px;color:var(--text-muted)">'+safe(a.sourceFile)+'</td></tr>';
      }).join(''):'<tr><td colspan="3" class="muted">No API endpoints tracked yet.</td></tr>';

      // Architecture decisions
      document.getElementById('decisions').innerHTML=decisions.length?decisions.map(function(d){
        var paths=(d.affectedPaths||[]).map(function(p){return '<span style="font-family:monospace;font-size:11px;padding:2px 6px;background:var(--bg-app);border:1px solid var(--border);border-radius:4px;">'+safe(p)+'</span>';}).join(' ');
        return '<div class="card" style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px"><div style="font-weight:500">'+safe(d.title)+'</div><span style="font-size:12px;color:var(--text-muted)">'+safe(d.createdAt?.slice(0,10))+'</span></div><pre style="margin-bottom:8px">'+safe(d.description)+'</pre>'+(d.context?'<pre style="color:var(--text-muted);font-size:11px;margin-bottom:8px">Context: '+safe(d.context)+'</pre>':'')+(paths?'<div style="display:flex;gap:4px;flex-wrap:wrap;">'+paths+'</div>':'')+'</div>';
      }).join(''):'<div class="muted" style="padding:16px;">No architecture decisions recorded.</div>';

      // File changes
      document.querySelector('#changes-table tbody').innerHTML=changes.length?changes.map(function(c){
        var gc=c.gatePassed?'#4ade80':'#f87171';
        return '<tr><td style="font-family:monospace;font-size:12px">'+safe(c.filePath)+'</td><td style="font-family:monospace;font-size:11px">'+safe(c.runId?.slice(0,10)||'—')+'</td><td style="font-size:12px">'+safe(c.taskId?.slice(0,10)||'—')+'</td><td>'+safe(c.changeType)+'</td><td style="color:'+gc+';font-weight:500">'+(c.gatePassed?'passed':'failed')+'</td><td style="font-size:12px;color:var(--text-muted)">'+safe(c.createdAt?.slice(0,10))+'</td></tr>';
      }).join(''):'<tr><td colspan="6" class="muted">No file changes recorded yet.</td></tr>';
    }
    load();
  `);
}

function buildSettingsPage(): string {
  return shellPage('Settings', '/settings', `
    <h1 class="page-title">Policy Settings</h1>
    <p class="page-subtitle">Configure autonomous run parameters, gate toggles, and token budgets.</p>

    <div style="display:flex;gap:8px;margin-bottom:24px;">
      <button class="preset-btn" data-preset="conservative" style="padding:8px 16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-app);color:var(--text-main);cursor:pointer;font-size:13px;font-weight:500;">Conservative</button>
      <button class="preset-btn" data-preset="balanced" style="padding:8px 16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-app);color:var(--text-main);cursor:pointer;font-size:13px;font-weight:500;">Balanced</button>
      <button class="preset-btn" data-preset="aggressive" style="padding:8px 16px;border:1px solid var(--border);border-radius:8px;background:var(--bg-app);color:var(--text-main);cursor:pointer;font-size:13px;font-weight:500;">Aggressive</button>
    </div>

    <div class="two-col" style="max-width:1000px;">
      <div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;">Run Parameters</div>
          <div id="run-params"></div>
        </div>
        <div class="card" style="margin-top:16px;">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;">Token Budgets</div>
          <div id="token-params"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;">Gate Toggles</div>
          <div id="gate-toggles"></div>
        </div>
        <div class="card" style="margin-top:16px;">
          <div style="font-weight:600;margin-bottom:16px;font-size:14px;">Branch Configuration</div>
          <div id="branch-config"></div>
        </div>
      </div>
    </div>

    <div style="margin-top:24px;">
      <button id="save-btn" style="padding:10px 28px;border:none;border-radius:8px;background:var(--text-main);color:var(--bg-app);font-weight:600;cursor:pointer;font-size:13px;">Save Policy</button>
      <span id="save-status" style="margin-left:12px;font-size:13px;color:var(--text-muted);"></span>
    </div>
  `, `
    var currentPolicy={};
    var project=new URLSearchParams(location.search).get('project')||'';

    function numField(label,key,hint){
      var v=currentPolicy[key]||0;
      return '<label style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;gap:12px;"><div><span>'+label+'</span>'+(hint?'<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">'+hint+'</div>':'')+'</div><input type="number" data-key="'+key+'" value="'+v+'" style="width:80px;background:var(--bg-app);border:1px solid var(--border);color:var(--text-main);padding:6px 8px;border-radius:6px;text-align:right;font-size:13px;"></label>';
    }

    function boolField(label,key,hint){
      var v=currentPolicy[key];
      return '<label style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;gap:12px;cursor:pointer;"><div><span>'+label+'</span>'+(hint?'<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">'+hint+'</div>':'')+'</div><input type="checkbox" data-key="'+key+'"'+(v?' checked':'')+' style="width:18px;height:18px;accent-color:#4ade80;cursor:pointer;"></label>';
    }

    function textField(label,key,hint){
      var v=currentPolicy[key]||'';
      return '<label style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;gap:12px;"><div><span>'+label+'</span>'+(hint?'<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">'+hint+'</div>':'')+'</div><input type="text" data-key="'+key+'" value="'+v+'" style="width:180px;background:var(--bg-app);border:1px solid var(--border);color:var(--text-main);padding:6px 8px;border-radius:6px;font-size:13px;font-family:monospace;"></label>';
    }

    function gateField(label,key,hint){
      var gates=currentPolicy.gates||{};var v=gates[key];
      return '<label style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;gap:12px;cursor:pointer;"><div><span>'+label+'</span>'+(hint?'<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">'+hint+'</div>':'')+'</div><input type="checkbox" data-gate="'+key+'"'+(v?' checked':'')+' style="width:18px;height:18px;accent-color:#4ade80;cursor:pointer;"></label>';
    }

    function render(){
      document.getElementById('run-params').innerHTML=[
        numField('Max Hours','maxHours','Max duration for a single run'),
        numField('Max Commits','maxCommits','Max commits per run'),
        numField('Max Parallel Tasks','maxParallelTasks','Concurrent task limit'),
        numField('Max Retries/Task','maxRetriesPerTask','Retry attempts on failure'),
        numField('Max Minutes/Task','maxMinutesPerTask','Per-task timeout (0=unlimited)'),
        numField('Max Improvement Cycles','maxImprovementCycles','Review-improve iterations'),
        boolField('Auto-Approve Plan','autoApprovePlan','Skip manual plan approval')
      ].join('');

      document.getElementById('token-params').innerHTML=[
        numField('Max Tokens/Run','maxTokensPerRun','Total token budget per run (0=unlimited)'),
        numField('Max Tokens/Task','maxTokensPerTask','Per-task token budget (0=unlimited)')
      ].join('');

      document.getElementById('gate-toggles').innerHTML=[
        gateField('TypeScript Check','runTypecheck','Run tsc --noEmit or npm run typecheck'),
        gateField('Lint','runLint','Run npm run lint'),
        gateField('Tests','runTests','Run npm run test'),
        gateField('Build','runBuild','Run npm run build'),
        gateField('Runtime Gate','runRuntime','Start dev server and probe'),
        gateField('Require Runtime for UI','requireRuntimeForUi','Fail if runtime gate skipped on UI tasks'),
        gateField('Capture Snapshot','captureSnapshot','Take screenshot after runtime gate'),
        gateField('Security Scan','runSecurityScan','Scan for hardcoded secrets/credentials'),
        gateField('Import Cycle Check','runImportCycleCheck','Detect circular import chains')
      ].join('');

      document.getElementById('branch-config').innerHTML=[
        textField('Integration Branch','integrationBranchName','Branch name for autonomous commits')
      ].join('');
    }

    async function load(){
      var url=project?'/api/policies/'+encodeURIComponent(project):'/api/policies/default';
      var r=await fetch(url);currentPolicy=await r.json();render();
    }

    function collectPolicy(){
      document.querySelectorAll('[data-key]').forEach(function(el){
        var k=el.dataset.key;
        if(el.type==='checkbox') currentPolicy[k]=el.checked;
        else if(el.type==='number') currentPolicy[k]=Number(el.value);
        else currentPolicy[k]=el.value;
      });
      if(!currentPolicy.gates)currentPolicy.gates={};
      document.querySelectorAll('[data-gate]').forEach(function(el){
        currentPolicy.gates[el.dataset.gate]=el.checked;
      });
    }

    document.getElementById('save-btn').onclick=async function(){
      collectPolicy();
      var url=project?'/api/policies/'+encodeURIComponent(project):'/api/policies/default';
      await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentPolicy)});
      document.getElementById('save-status').textContent='Saved!';
      setTimeout(function(){document.getElementById('save-status').textContent='';},2000);
    };

    document.querySelectorAll('.preset-btn').forEach(function(btn){
      btn.onclick=async function(){
        var url=project?'/api/policies/'+encodeURIComponent(project):'/api/policies/default';
        await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({preset:btn.dataset.preset})});
        await load();
        document.getElementById('save-status').textContent='Preset applied!';
        setTimeout(function(){document.getElementById('save-status').textContent='';},2000);
      };
    });

    load();
  `);
}

function buildLearningPage(): string {
  return shellPage('Learning', '/learning', `
    <h1 class="page-title">Learning Patterns</h1>
    <p class="page-subtitle">Patterns extracted from successful tasks. Each row shows what worked and where. Click a pattern to inspect its approach, files, tools, and outcomes.</p>

    <div class="card-grid" id="learning-stats"></div>

    <h2 class="section-title section-gap">Top Tags</h2>
    <div id="tag-cloud" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px;"></div>

    <h2 class="section-title section-gap">Pattern Browser</h2>
    <div style="display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
      <input id="pat-search" type="text" placeholder="Search patterns, approach, file paths..." style="flex:1;min-width:260px;background:var(--bg-surface);border:1px solid var(--border);color:var(--text-main);padding:10px 14px;border-radius:8px;font-size:13px;outline:none;">
      <select id="pat-kind-filter" style="background:var(--bg-surface);border:1px solid var(--border);color:var(--text-main);padding:10px 14px;border-radius:8px;font-size:13px;outline:none;">
        <option value="all">All Kinds</option>
        <option value="implement">implement</option><option value="improve">improve</option>
        <option value="heal">heal</option><option value="review">review</option>
      </select>
      <select id="pat-project-filter" style="background:var(--bg-surface);border:1px solid var(--border);color:var(--text-main);padding:10px 14px;border-radius:8px;font-size:13px;outline:none;">
        <option value="all">All Projects</option>
      </select>
      <div id="tag-filter-chip" style="display:none;align-items:center;gap:8px;padding:8px 12px;background:#a78bfa15;border:1px solid #a78bfa50;border-radius:99px;font-size:12px;color:#a78bfa;cursor:pointer;" title="Click to clear tag filter">
        <span id="tag-filter-label"></span>
        <span style="opacity:0.7;font-size:14px;line-height:1;">×</span>
      </div>
    </div>
    <div id="pattern-list"></div>

    <div id="pattern-detail" style="display:none;margin-top:24px;">
      <div class="card" style="margin-bottom:16px;">
        <div id="detail-header"></div>
        <div id="detail-tabs" style="display:flex;gap:2px;margin:20px 0 0;border-bottom:1px solid var(--border);">
          <button type="button" class="pat-tab active" data-tab="approach" style="background:transparent;border:none;color:var(--text-main);padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid var(--text-main);">Approach</button>
          <button type="button" class="pat-tab" data-tab="files" style="background:transparent;border:none;color:var(--text-muted);padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;">Files</button>
          <button type="button" class="pat-tab" data-tab="tools" style="background:transparent;border:none;color:var(--text-muted);padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;">Tools</button>
          <button type="button" class="pat-tab" data-tab="outcomes" style="background:transparent;border:none;color:var(--text-muted);padding:10px 16px;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;">Outcomes</button>
        </div>
        <div id="detail-body" style="padding-top:20px;"></div>
      </div>
    </div>
  `, `
    function safe(v){return String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
    function bar(ratio,color){return '<div style="height:8px;background:var(--bg-app);border-radius:99px;overflow:hidden;width:80px;display:inline-block;vertical-align:middle;"><div style="height:100%;border-radius:99px;width:'+Math.max(0,Math.round(ratio*50+50))+'%;background:'+color+'"></div></div>';}
    function effColor(s){return s>0.3?'#4ade80':s<-0.1?'#f87171':'#f59e0b';}
    function ago(d){if(!d)return'—';var ms=Date.now()-new Date(d).getTime(),m=Math.round(ms/60000);if(m<1)return'just now';if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<24)return h+'h ago';return Math.round(h/24)+'d ago';}

    var allPatterns=[];
    var selectedPatternId=null;
    var selectedTab='approach';
    var outcomeCache={};
    var tagFilter=null;

    function renderTagCloud(tags){
      var max=Math.max.apply(null,tags.map(function(t){return t.patternCount;}).concat([1]));
      document.getElementById('tag-cloud').innerHTML=tags.slice(0,30).map(function(t){
        var ratio=t.patternCount/max;
        var size=12+Math.round(ratio*6);
        var c=effColor(t.avgEffectiveness);
        var active=tagFilter===t.tag;
        return '<span class="tag-pill" data-tag="'+safe(t.tag)+'" style="cursor:pointer;padding:4px 10px;border-radius:99px;background:'+(active?'#a78bfa25':'var(--bg-surface)')+';border:1px solid '+(active?'#a78bfa80':'var(--border)')+';font-size:'+size+'px;color:'+c+';font-weight:500;" title="'+t.patternCount+' pattern(s), '+t.totalApplications+' applications">'+safe(t.tag)+' <span style="color:var(--text-muted);font-size:11px;">·'+t.patternCount+'</span></span>';
      }).join('');
      document.querySelectorAll('.tag-pill').forEach(function(el){
        el.onclick=function(){
          tagFilter=tagFilter===el.dataset.tag?null:el.dataset.tag;
          updateTagFilterChip();
          renderTagCloud(tags);
          renderPatterns();
        };
      });
    }

    function updateTagFilterChip(){
      var chip=document.getElementById('tag-filter-chip');
      if(tagFilter){
        chip.style.display='inline-flex';
        document.getElementById('tag-filter-label').textContent='tag: '+tagFilter;
      }else{
        chip.style.display='none';
      }
    }
    document.getElementById('tag-filter-chip').onclick=function(){tagFilter=null;updateTagFilterChip();renderPatterns();};

    function renderPatterns(){
      var search=(document.getElementById('pat-search').value||'').toLowerCase();
      var kind=document.getElementById('pat-kind-filter').value;
      var project=document.getElementById('pat-project-filter').value;
      var filtered=allPatterns.filter(function(p){
        if(kind!=='all'&&p.taskKind!==kind)return false;
        if(project!=='all'&&p.projectName!==project)return false;
        if(tagFilter&&!(p.tags||[]).includes(tagFilter))return false;
        if(search){
          var hay=[p.taskKind,p.filePattern,p.approach,p.projectName,(p.tags||[]).join(' '),(p.filesEdited||[]).join(' '),p.sourceTaskTitle||''].join(' ').toLowerCase();
          if(!hay.includes(search))return false;
        }
        return true;
      });

      document.getElementById('pattern-list').innerHTML=filtered.length?filtered.map(function(p){
        var c=effColor(p.effectivenessScore);
        var active=selectedPatternId===p.id;
        var tagsHtml=(p.tags||[]).slice(0,6).map(function(t){return '<span style="padding:2px 8px;border-radius:99px;background:var(--bg-app);border:1px solid var(--border);font-size:11px;color:var(--text-muted);">'+safe(t)+'</span>';}).join(' ');
        var title=p.sourceTaskTitle||p.approach?.slice(0,80)||'(untitled pattern)';
        return '<div class="card" data-pid="'+safe(p.id)+'" style="margin-bottom:8px;cursor:pointer;transition:all 0.15s;'+(active?'border-color:#71717a;background:linear-gradient(180deg,rgba(39,39,42,0.95),rgba(24,24,27,0.98));':'')+'">'
          +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;">'
          +'<div style="flex:1;min-width:0;">'
          +'<div style="font-weight:500;font-size:14px;margin-bottom:4px;">'+safe(title)+'</div>'
          +'<div style="display:flex;gap:10px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;"><span>'+safe(p.taskKind)+'</span><span style="font-family:monospace;">'+safe(p.filePattern)+'</span><span>'+safe(p.projectName)+'</span></div>'
          +'</div>'
          +'<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">'+bar(p.effectivenessScore,c)+'<span style="font-size:13px;font-weight:500;color:'+c+';min-width:42px;text-align:right;">'+(p.effectivenessScore*100).toFixed(0)+'%</span></div>'
          +'</div>'
          +(tagsHtml?'<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px;">'+tagsHtml+'</div>':'')
          +'<div style="display:flex;gap:16px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;"><span>Applied '+p.timesApplied+'</span><span style="color:#4ade80">Succeeded '+p.timesSucceeded+'</span><span style="color:#f87171">Failed '+p.timesFailed+'</span><span>'+ago(p.updatedAt||p.createdAt)+'</span></div>'
          +'</div>';
      }).join(''):'<div class="muted" style="padding:24px;text-align:center;">No patterns match your filters.</div>';

      document.querySelectorAll('[data-pid]').forEach(function(el){
        el.onclick=function(){selectPattern(el.dataset.pid);};
      });
    }

    function renderDetailBody(p){
      if(selectedTab==='approach'){
        var tagsHtml=(p.tags&&p.tags.length)?'<div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;"><span style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-right:6px;align-self:center;">Tags:</span>'+p.tags.map(function(t){return '<span style="padding:2px 8px;border-radius:99px;background:var(--bg-app);border:1px solid var(--border);font-size:11px;color:var(--text-muted);">'+safe(t)+'</span>';}).join('')+'</div>':'';
        document.getElementById('detail-body').innerHTML='<pre style="background:var(--bg-app);padding:16px;border-radius:8px;border:1px solid var(--border);white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px;line-height:1.6;">'+safe(p.approach||'(no approach recorded)')+'</pre>'+tagsHtml;
        return;
      }
      if(selectedTab==='files'){
        var readHtml=(p.filesRead||[]).length?'<ul style="list-style:none;padding:0;margin:0;">'+p.filesRead.map(function(f){return '<li style="font-family:ui-monospace,monospace;font-size:12px;padding:6px 10px;background:var(--bg-app);border:1px solid var(--border);border-radius:6px;margin-bottom:4px;color:var(--text-muted);">'+safe(f)+'</li>';}).join('')+'</ul>':'<div class="muted">No files recorded.</div>';
        var editHtml=(p.filesEdited||[]).length?'<ul style="list-style:none;padding:0;margin:0;">'+p.filesEdited.map(function(f){return '<li style="font-family:ui-monospace,monospace;font-size:12px;padding:6px 10px;background:#4ade8010;border:1px solid #4ade8030;border-radius:6px;margin-bottom:4px;">'+safe(f)+'</li>';}).join('')+'</ul>':'<div class="muted">No files edited.</div>';
        document.getElementById('detail-body').innerHTML='<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;"><div><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:8px;">Files Read ('+(p.filesRead||[]).length+')</div>'+readHtml+'</div><div><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:8px;">Files Edited ('+(p.filesEdited||[]).length+')</div>'+editHtml+'</div></div>';
        return;
      }
      if(selectedTab==='tools'){
        var tools=p.topTools||[];
        if(!tools.length){document.getElementById('detail-body').innerHTML='<div class="muted">No tool usage recorded for this pattern.</div>';return;}
        document.getElementById('detail-body').innerHTML='<div style="display:flex;gap:8px;flex-wrap:wrap;">'+tools.map(function(t){return '<span style="padding:6px 12px;border-radius:8px;background:var(--bg-app);border:1px solid var(--border);font-family:ui-monospace,monospace;font-size:12px;">'+safe(t)+'</span>';}).join('')+'</div>';
        return;
      }
      if(selectedTab==='outcomes'){
        var outcomes=outcomeCache[p.id]||[];
        if(!outcomes.length){document.getElementById('detail-body').innerHTML='<div class="muted">No outcomes recorded for this pattern yet.</div>';return;}
        document.getElementById('detail-body').innerHTML='<table style="width:100%;border-collapse:collapse;font-size:13px;"><thead><tr><th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Task</th><th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Project</th><th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Result</th><th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Iterations</th><th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">Tokens</th><th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">When</th></tr></thead><tbody>'+outcomes.map(function(o){
          var rc=o.succeeded?'#4ade80':'#f87171';
          var runLink='<a href="/runs/'+encodeURIComponent(o.runId)+'" style="color:#60a5fa;text-decoration:none;font-size:12px;">open</a>';
          return '<tr><td style="padding:8px 10px;border-bottom:1px solid #1e1e21;"><div style="font-weight:500;">'+safe(o.taskTitle||'(untitled)')+'</div><div style="font-family:ui-monospace,monospace;font-size:11px;color:var(--text-muted);">'+safe((o.taskId||'').slice(0,16))+'</div></td><td style="padding:8px 10px;border-bottom:1px solid #1e1e21;">'+safe(o.runProjectName||'—')+' · '+runLink+'</td><td style="padding:8px 10px;border-bottom:1px solid #1e1e21;"><span style="color:'+rc+';font-weight:500;">'+(o.succeeded?'success':'failure')+'</span></td><td style="padding:8px 10px;border-bottom:1px solid #1e1e21;">'+(o.iterations||'—')+'</td><td style="padding:8px 10px;border-bottom:1px solid #1e1e21;">'+((o.tokensUsed||0).toLocaleString())+'</td><td style="padding:8px 10px;border-bottom:1px solid #1e1e21;color:var(--text-muted);font-size:12px;">'+ago(o.createdAt)+'</td></tr>';
        }).join('')+'</tbody></table>';
      }
    }

    async function selectPattern(id){
      selectedPatternId=id;
      selectedTab='approach';
      renderPatterns();
      var p=allPatterns.find(function(x){return x.id===id;});
      if(!p){document.getElementById('pattern-detail').style.display='none';return;}
      document.getElementById('pattern-detail').style.display='block';
      var c=effColor(p.effectivenessScore);
      document.getElementById('detail-header').innerHTML='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">'
        +'<div style="flex:1;min-width:200px;">'
        +'<div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;margin-bottom:4px;">Source Task</div>'
        +'<div style="font-size:18px;font-weight:500;margin-bottom:4px;">'+safe(p.sourceTaskTitle||'(untitled)')+'</div>'
        +'<div style="font-size:12px;color:var(--text-muted);">'+safe(p.sourceRunPrompt||'')+'</div>'
        +'</div>'
        +'<div style="display:flex;gap:12px;flex-shrink:0;flex-wrap:wrap;">'
        +'<div style="background:var(--bg-app);border:1px solid var(--border);border-radius:8px;padding:10px 14px;"><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;">Effectiveness</div><div style="font-size:18px;font-weight:500;color:'+c+'">'+(p.effectivenessScore*100).toFixed(1)+'%</div></div>'
        +'<div style="background:var(--bg-app);border:1px solid var(--border);border-radius:8px;padding:10px 14px;"><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;">Applied</div><div style="font-size:18px;font-weight:500;">'+p.timesApplied+'<span style="font-size:12px;color:var(--text-muted);margin-left:6px;">('+p.timesSucceeded+'/'+p.timesFailed+')</span></div></div>'
        +'<div style="background:var(--bg-app);border:1px solid var(--border);border-radius:8px;padding:10px 14px;"><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;">Iterations</div><div style="font-size:18px;font-weight:500;">'+(p.iterations||'—')+'</div></div>'
        +'<div style="background:var(--bg-app);border:1px solid var(--border);border-radius:8px;padding:10px 14px;"><div style="font-size:11px;text-transform:uppercase;color:var(--text-muted);font-weight:600;">Tokens</div><div style="font-size:18px;font-weight:500;">'+((p.tokensUsed||0).toLocaleString())+'</div></div>'
        +'</div></div>'
        +'<div style="display:flex;gap:12px;margin-top:12px;font-size:12px;color:var(--text-muted);flex-wrap:wrap;"><span>Kind: <strong style="color:var(--text-main);">'+safe(p.taskKind)+'</strong></span><span>File pattern: <strong style="font-family:ui-monospace,monospace;color:var(--text-main);">'+safe(p.filePattern)+'</strong></span><span>Project: <strong style="color:var(--text-main);">'+safe(p.projectName)+'</strong></span></div>';

      // Fetch outcomes once per pattern
      if(!outcomeCache[p.id]){
        try{
          var r=await fetch('/api/learning/patterns/'+encodeURIComponent(id)+'/outcomes');
          outcomeCache[p.id]=await r.json();
        }catch(e){outcomeCache[p.id]=[];}
      }

      renderDetailBody(p);
    }

    document.querySelectorAll('.pat-tab').forEach(function(tab){
      tab.onclick=function(){
        selectedTab=tab.dataset.tab;
        document.querySelectorAll('.pat-tab').forEach(function(t){
          var active=t===tab;
          t.style.color=active?'var(--text-main)':'var(--text-muted)';
          t.style.borderBottomColor=active?'var(--text-main)':'transparent';
          t.classList.toggle('active',active);
        });
        var p=allPatterns.find(function(x){return x.id===selectedPatternId;});
        if(p)renderDetailBody(p);
      };
    });

    function populateProjectFilter(){
      var sel=document.getElementById('pat-project-filter');
      var projects=Array.from(new Set(allPatterns.map(function(p){return p.projectName;}))).sort();
      sel.innerHTML='<option value="all">All Projects</option>'+projects.map(function(p){return '<option value="'+safe(p)+'">'+safe(p)+'</option>';}).join('');
    }

    async function load(){
      const [statsR,patternsR,tagsR]=await Promise.all([
        fetch('/api/learning/stats'),
        fetch('/api/learning/patterns?limit=200'),
        fetch('/api/learning/tags')
      ]);
      const stats=await statsR.json();
      allPatterns=await patternsR.json();
      const tags=await tagsR.json();

      document.getElementById('learning-stats').innerHTML=[
        ['Total Patterns',stats.totalPatterns||0,'#60a5fa'],
        ['Effective',stats.effectivePatterns||0,'#4ade80'],
        ['Applications',stats.totalApplications||0,'#a78bfa'],
        ['Success Rate',((stats.overallSuccessRate||0)*100).toFixed(1)+'%','#4ade80'],
        ['Avg Iterations',stats.avgIterationsLearned?stats.avgIterationsLearned.toFixed(1):'—','#f59e0b']
      ].map(function(c){return '<div class="card"><div class="card-label">'+c[0]+'</div><div class="card-value" style="color:'+c[2]+'">'+c[1]+'</div></div>';}).join('');

      populateProjectFilter();
      renderTagCloud(tags);
      renderPatterns();
    }

    document.getElementById('pat-search').addEventListener('input',renderPatterns);
    document.getElementById('pat-kind-filter').addEventListener('change',renderPatterns);
    document.getElementById('pat-project-filter').addEventListener('change',renderPatterns);
    load();
  `);
}

export function startUnityHttpServer(runtime: RuntimeState) {
  const config = getRuntimeConfig();

  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: 'Missing request metadata.' });
      return;
    }

    const url = new URL(req.url, `http://localhost:${config.localConsolePort}`);
    const pathname = url.pathname;

    try {
      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/webhooks/github') {
        await handleGitHubWebhook(req, res, runtime);
        return;
      }

      if (req.method === 'GET' && pathname === '/') {
        sendHtml(res, buildHomePageShell());
        return;
      }

      if (req.method === 'GET' && pathname === '/analytics') {
        sendHtml(res, buildAnalyticsPage());
        return;
      }

      if (req.method === 'GET' && pathname === '/knowledge') {
        sendHtml(res, buildKnowledgePage());
        return;
      }

      if (req.method === 'GET' && pathname === '/settings') {
        sendHtml(res, buildSettingsPage());
        return;
      }

      if (req.method === 'GET' && pathname === '/learning') {
        sendHtml(res, buildLearningPage());
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/runs/')) {
        const runId = pathname.slice('/runs/'.length);
        sendHtml(res, renderRunPage(runId, buildRunPayload(runId), url.searchParams.get('task')));
        return;
      }

      if (req.method === 'POST' && extractConsoleRunId(pathname, '/approve-plan')) {
        const runId = extractConsoleRunId(pathname, '/approve-plan') as string;

        if (runtime.isProcessing()) {
          redirect(res, `/runs/${runId}`);
          return;
        }

        const abortController = runtime.startProcessing();
        try {
          approveAutonomousRunPlan(runId, 'local-ui-form');
        } catch (error) {
          runtime.finishProcessing();
          throw error;
        }

        void resumeAutonomousRun({
          runId,
          signal: abortController.signal,
          onProgress: async (message) => {
            console.log(`[unity-console][${runId}] ${message}`);
            unityStore.addEvent(createEntityId('event'), runId, null, 'info', 'run.progress', message);
          },
        })
          .catch((error: any) => {
            console.error(error);
            const message = error?.message || String(error);
            unityStore.updateRun(runId, {
              status: message === 'AbortError' ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(),
              summary: message,
            });
            unityStore.addEvent(
              createEntityId('event'),
              runId,
              null,
              message === 'AbortError' ? 'warning' : 'error',
              message === 'AbortError' ? 'run.cancelled' : 'run.failed',
              message,
            );
          })
          .finally(() => {
            runtime.finishProcessing();
          });

        redirect(res, `/runs/${runId}`);
        return;
      }

      if (req.method === 'POST' && extractConsoleRunId(pathname, '/reject-plan')) {
        const runId = extractConsoleRunId(pathname, '/reject-plan') as string;
        const body = await readFormBody(req);
        const reason = body.reason?.trim() || 'Plan rejected from the local console.';
        rejectAutonomousRunPlan(runId, 'local-ui-form', reason);
        redirect(res, `/runs/${runId}`);
        return;
      }

      if (req.method === 'POST' && extractConsoleRunId(pathname, '/cancel')) {
        runtime.abortCurrentTask();
        redirect(res, `/runs/${extractConsoleRunId(pathname, '/cancel')}`);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/runs') {
        sendJson(res, 200, buildRunsListPayload());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/runs/resumable') {
        sendJson(res, 200, unityStore.listResumableRuns());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/projects') {
        sendJson(res, 200, listAvailableProjects());
        return;
      }

      if (req.method === 'POST' && pathname === '/api/runs') {
        try {
          const body = await readJsonBody(req);
          const projectName = String(body.projectName || '').trim();
          const prompt = String(body.prompt || '').trim();
          const mode = body.mode === 'nightly' ? 'nightly' : 'interactive';

          if (!projectName || !prompt) {
            sendJson(res, 400, { error: 'projectName and prompt are required.' });
            return;
          }

          const project = getProjectByName(projectName);
          if (!fs.existsSync(project.repoPath)) {
            sendJson(res, 404, { error: `Project "${projectName}" not found in ${WORKSPACE_DIR}.` });
            return;
          }

          const plan = await createAutonomousRunPlan({
            project,
            prompt,
            channelName: 'panel',
            mode,
          });

          if (!plan.requiresApproval) {
            // Nightly mode auto-approves — kick off the resumer in background.
            resumeAutonomousRun({ runId: plan.runId }).catch((err) => {
              console.error(`[panel] Autonomous run ${plan.runId} failed:`, err);
            });
          }

          sendJson(res, 201, {
            runId: plan.runId,
            branchName: plan.branchName,
            requiresApproval: plan.requiresApproval,
            autoApproved: plan.autoApproved,
            consoleUrl: plan.consoleUrl,
            tasks: plan.tasks,
          });
          return;
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message || 'Failed to create run.' });
          return;
        }
      }

      if (req.method === 'GET' && pathname === '/api/pair-sessions') {
        sendJson(res, 200, pairSessions);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/pair-sessions') {
        try {
          const body = await readJsonBody(req);
          const projectName = String(body.projectName || '').trim();
          const prompt = String(body.prompt || '').trim();
          const isIteration = Boolean(body.isIteration);

          if (!projectName || !prompt) {
            sendJson(res, 400, { error: 'projectName and prompt are required.' });
            return;
          }

          const project = getProjectByName(projectName);
          if (!fs.existsSync(project.repoPath)) {
            sendJson(res, 404, { error: `Project "${projectName}" not found.` });
            return;
          }

          // Pair-mode runs are synchronous and may take a while. Kick off in
          // background and track in the in-memory ledger so the panel can show them.
          const sessionId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const record = recordPairSession(sessionId, projectName, prompt);
          runDevelopmentTask({ project, prompt, isIteration })
            .then((result) => {
              record.status = 'succeeded';
              record.finishedAt = new Date().toISOString();
              record.commitMessage = result.commitMessage;
              console.log(`[panel] Pair session ${sessionId} completed:`, result.commitMessage);
            })
            .catch((err) => {
              record.status = 'failed';
              record.finishedAt = new Date().toISOString();
              record.error = err?.message || String(err);
              console.error(`[panel] Pair session ${sessionId} failed:`, err);
            });

          sendJson(res, 202, { sessionId, projectName, prompt, mode: 'pair' });
          return;
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message || 'Failed to start pair session.' });
          return;
        }
      }

      if (req.method === 'GET' && extractRunId(pathname)) {
        const runId = extractRunId(pathname) as string;
        const payload = buildRunPayload(runId);
        if (!payload) {
          sendJson(res, 404, { error: `Run ${runId} was not found.` });
          return;
        }

        sendJson(res, 200, payload);
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/plan')) {
        const runId = extractRunId(pathname, '/plan') as string;
        sendJson(res, 200, unityStore.getLatestPlanByRun(runId));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/tasks')) {
        const runId = extractRunId(pathname, '/tasks') as string;
        sendJson(res, 200, unityStore.listTasksByRun(runId));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/events')) {
        const runId = extractRunId(pathname, '/events') as string;
        sendJson(res, 200, unityStore.listEventsByRun(runId));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/artifacts')) {
        const runId = extractRunId(pathname, '/artifacts') as string;
        sendJson(res, 200, unityStore.listArtifactsByRun(runId));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/plans')) {
        const runId = extractRunId(pathname, '/plans') as string;
        sendJson(res, 200, unityStore.listPlansByRun(runId));
        return;
      }

      if (req.method === 'POST' && extractRunId(pathname, '/approve-plan')) {
        const runId = extractRunId(pathname, '/approve-plan') as string;
        const body = await readJsonBody(req);
        const approvedBy = typeof body.approvedBy === 'string' && body.approvedBy.trim() ? body.approvedBy : 'local-ui';

        if (runtime.isProcessing()) {
          sendJson(res, 409, { error: 'Unity Agent is already processing another run.' });
          return;
        }

        const abortController = runtime.startProcessing();
        try {
          approveAutonomousRunPlan(runId, approvedBy);
        } catch (error) {
          runtime.finishProcessing();
          throw error;
        }

        void resumeAutonomousRun({
          runId,
          signal: abortController.signal,
          onProgress: async (message) => {
            console.log(`[unity-console][${runId}] ${message}`);
            unityStore.addEvent(createEntityId('event'), runId, null, 'info', 'run.progress', message);
          },
        })
          .catch((error: any) => {
            console.error(error);
            const message = error?.message || String(error);
            unityStore.updateRun(runId, {
              status: message === 'AbortError' ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(),
              summary: message,
            });
            unityStore.addEvent(
              createEntityId('event'),
              runId,
              null,
              message === 'AbortError' ? 'warning' : 'error',
              message === 'AbortError' ? 'run.cancelled' : 'run.failed',
              message,
            );
          })
          .finally(() => {
            runtime.finishProcessing();
          });

        sendJson(res, 202, {
          ok: true,
          runId,
          message: 'Plan approved. Run resumed in the background.',
        });
        return;
      }

      if (req.method === 'POST' && extractRunId(pathname, '/reject-plan')) {
        const runId = extractRunId(pathname, '/reject-plan') as string;
        const body = await readJsonBody(req);
        const rejectedBy =
          typeof body.rejectedBy === 'string' && body.rejectedBy.trim() ? body.rejectedBy : 'local-ui';
        const reason =
          typeof body.reason === 'string' && body.reason.trim()
            ? body.reason
            : 'Plan rejected from the local console.';

        rejectAutonomousRunPlan(runId, rejectedBy, reason);
        sendJson(res, 200, {
          ok: true,
          runId,
          message: 'Plan rejected.',
        });
        return;
      }

      if (req.method === 'POST' && extractRunId(pathname, '/cancel')) {
        if (!runtime.abortCurrentTask()) {
          sendJson(res, 409, { error: 'No active run is currently executing.' });
          return;
        }

        sendJson(res, 202, { ok: true, message: 'Abort requested.' });
        return;
      }

      /* ── Close-the-loop: open a PR for a run's integration branch ── */
      if (req.method === 'POST' && extractRunId(pathname, '/create-pr')) {
        const runId = extractRunId(pathname, '/create-pr') as string;
        const run = unityStore.getRun(runId);
        if (!run) {
          sendJson(res, 404, { error: `Run ${runId} not found.` });
          return;
        }
        try {
          const project = getProjectByName(run.projectName);
          const title = `✨ ${truncate(run.prompt, 70)}`;
          const body = [
            `Autonomous run \`${runId}\` on \`${run.branchName}\`.`,
            '',
            `**Objective:** ${run.prompt}`,
            '',
            run.summary ? `**Summary:**\n${run.summary}` : '',
          ].join('\n');
          const prUrl = await createPullRequestFromBranch(
            run.projectName,
            project.repoPath,
            run.branchName,
            title,
            body,
          );
          unityStore.addEvent(createEntityId('event'), runId, null, 'info', 'run.pr_created', `PR opened: ${prUrl}`);
          sendJson(res, 201, { ok: true, prUrl });
        } catch (err: any) {
          sendJson(res, 500, { error: err?.message || 'Failed to open PR.' });
        }
        return;
      }

      /* ── Run the project LOCALLY so you can see it (FE + BE up, URLs returned) ── */
      if (req.method === 'POST' && extractRunId(pathname, '/run-local')) {
        const runId = extractRunId(pathname, '/run-local') as string;
        const run = unityStore.getRun(runId);
        if (!run) {
          sendJson(res, 404, { error: `Run ${runId} not found.` });
          return;
        }
        const project = getProjectByName(run.projectName);
        // Reuse the runtime gate: it starts backends+frontends, links the backend
        // URL into the frontend, and leaves the processes RUNNING (cleanup only
        // happens at the start of the next gate run), so you can open the URLs.
        unityStore.addEvent(createEntityId('event'), runId, null, 'info', 'run.local_start', 'Starting project locally from panel...');
        void resolveWorkspace(project)
          .then((workspace) =>
            runProjectRuntimeGate(workspace, '/', (m) => {
              console.log(`[run-local][${runId}] ${m}`);
              unityStore.addEvent(createEntityId('event'), runId, null, 'info', 'run.local_progress', m);
            }),
          )
          .then((result) => {
            unityStore.addEvent(
              createEntityId('event'),
              runId,
              null,
              result.status === 'passed' ? 'info' : 'error',
              result.status === 'passed' ? 'run.local_ready' : 'run.local_failed',
              result.status === 'passed'
                ? `Project running locally. ${result.localUrl ? 'Local: ' + result.localUrl : ''}${result.publicUrl ? ' | Wi-Fi: ' + result.publicUrl : ''}`
                : `Could not start locally: ${result.details}`,
              { localUrl: result.localUrl, publicUrl: result.publicUrl },
            );
          })
          .catch((err) => {
            unityStore.addEvent(createEntityId('event'), runId, null, 'error', 'run.local_failed', err?.message || String(err));
          });
        sendJson(res, 202, { ok: true, message: 'Starting project locally. Watch the run events for the URL.' });
        return;
      }

      /* ── Telemetry / Cost Dashboard API ── */

      if (req.method === 'GET' && extractRunId(pathname, '/cost')) {
        const runId = extractRunId(pathname, '/cost') as string;
        const telemetryStore = getTelemetryStore();
        const summary = telemetryStore.getRunCostSummary(runId);
        const taskCosts = telemetryStore.getTaskCosts(runId);
        sendJson(res, 200, { summary, taskCosts });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/telemetry/stats') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const days = Number(url.searchParams.get('days') || 30);
        const telemetryStore = getTelemetryStore();
        sendJson(res, 200, telemetryStore.getProjectStats(projectName, days));
        return;
      }

      if (req.method === 'GET' && extractRunId(pathname, '/telemetry')) {
        const runId = extractRunId(pathname, '/telemetry') as string;
        const limit = Number(url.searchParams.get('limit') || 200);
        const telemetryStore = getTelemetryStore();
        sendJson(res, 200, telemetryStore.listEventsByRun(runId, limit));
        return;
      }

      /* ── Learning API ── */

      if (req.method === 'GET' && pathname === '/api/learning/patterns') {
        const limit = Number(url.searchParams.get('limit') || 20);
        const learningStore = getLearningStore();
        const patterns = learningStore.getTopPatterns(limit);
        // Enrich each pattern with the source task's title so the UI can show it.
        const enriched = patterns.map((p) => {
          const sourceTask = p.sourceTaskId ? unityStore.getTask(p.sourceTaskId) : null;
          const sourceRun = p.sourceRunId ? unityStore.getRun(p.sourceRunId) : null;
          return {
            ...p,
            sourceTaskTitle: sourceTask?.title || null,
            sourceRunPrompt: sourceRun?.prompt || null,
          };
        });
        sendJson(res, 200, enriched);
        return;
      }

      if (req.method === 'GET' && pathname.startsWith('/api/learning/patterns/') && pathname.endsWith('/outcomes')) {
        const patternId = pathname.slice('/api/learning/patterns/'.length, -'/outcomes'.length);
        const learningStore = getLearningStore();
        const outcomes = learningStore.getPatternOutcomes(patternId);
        // Enrich each outcome with task title and run project for display.
        const enriched = outcomes.map((o) => {
          const task = unityStore.getTask(o.taskId);
          const run = unityStore.getRun(o.runId);
          return {
            ...o,
            taskTitle: task?.title || null,
            runProjectName: run?.projectName || null,
          };
        });
        sendJson(res, 200, enriched);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/learning/stats') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const learningStore = getLearningStore();
        sendJson(res, 200, learningStore.getProjectLearningStats(projectName));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/learning/tags') {
        // Aggregate tag frequency + average effectiveness across all patterns.
        const learningStore = getLearningStore();
        const allPatterns = learningStore.getTopPatterns(500);
        const tagMap = new Map<string, { count: number; totalEff: number; totalApplied: number }>();
        for (const p of allPatterns) {
          for (const tag of p.tags || []) {
            const entry = tagMap.get(tag) || { count: 0, totalEff: 0, totalApplied: 0 };
            entry.count++;
            entry.totalEff += p.effectivenessScore;
            entry.totalApplied += p.timesApplied;
            tagMap.set(tag, entry);
          }
        }
        const tags = Array.from(tagMap.entries())
          .map(([tag, v]) => ({
            tag,
            patternCount: v.count,
            avgEffectiveness: v.count > 0 ? v.totalEff / v.count : 0,
            totalApplications: v.totalApplied,
          }))
          .sort((a, b) => b.patternCount - a.patternCount);
        sendJson(res, 200, tags);
        return;
      }

      /* ── Diff Viewer API ── */

      if (req.method === 'GET' && extractRunId(pathname, '/diff')) {
        const runId = extractRunId(pathname, '/diff') as string;
        const run = unityStore.getRun(runId);
        if (!run) {
          sendJson(res, 404, { error: `Run ${runId} not found.` });
          return;
        }

        try {
          const repoDir = `${WORKSPACE_DIR}/${run.projectName}`;
          const diff = execSync(
            `git diff ${run.defaultBranch}...${run.branchName} 2>/dev/null || git diff HEAD~1 2>/dev/null || echo "No diff available"`,
            { cwd: repoDir, maxBuffer: 5 * 1024 * 1024, timeout: 10000 },
          ).toString();
          sendJson(res, 200, { runId, branchName: run.branchName, diff });
        } catch {
          sendJson(res, 200, { runId, branchName: run.branchName, diff: 'Unable to generate diff.' });
        }
        return;
      }

      /* ── Re-run Failed Tasks API ── */

      if (req.method === 'POST' && extractRunId(pathname, '/rerun-failed')) {
        const runId = extractRunId(pathname, '/rerun-failed') as string;
        const run = unityStore.getRun(runId);
        if (!run) {
          sendJson(res, 404, { error: `Run ${runId} not found.` });
          return;
        }

        const failedTasks = unityStore.listTasksByRun(runId).filter((t) => t.status === 'failed');
        if (failedTasks.length === 0) {
          sendJson(res, 200, { ok: true, message: 'No failed tasks to re-run.', resetCount: 0 });
          return;
        }

        for (const task of failedTasks) {
          unityStore.updateTask(task.id, { status: 'pending', attempts: 0 });
        }

        if (run.status === 'failed' || run.status === 'completed_with_warnings') {
          unityStore.updateRun(runId, { status: 'running', finishedAt: null });
        }

        sendJson(res, 200, {
          ok: true,
          message: `Reset ${failedTasks.length} failed task(s) to pending.`,
          resetCount: failedTasks.length,
          taskIds: failedTasks.map((t) => t.id),
        });
        return;
      }

      /* ── Task Timeline API ── */

      if (req.method === 'GET' && extractRunId(pathname, '/timeline')) {
        const runId = extractRunId(pathname, '/timeline') as string;
        const tasks = unityStore.listTasksByRun(runId);
        const events = unityStore.listEventsByRun(runId);

        const timeline = tasks
          .filter((t) => t.startedAt)
          .map((t) => ({
            taskId: t.id,
            title: t.title,
            status: t.status,
            startedAt: t.startedAt,
            finishedAt: t.finishedAt,
            durationMs:
              t.startedAt && t.finishedAt
                ? new Date(t.finishedAt).getTime() - new Date(t.startedAt).getTime()
                : null,
          }))
          .sort((a, b) => new Date(a.startedAt!).getTime() - new Date(b.startedAt!).getTime());

        sendJson(res, 200, { runId, timeline, eventCount: events.length });
        return;
      }

      /* ── Knowledge Graph API ── */

      if (req.method === 'GET' && pathname === '/api/knowledge/snapshot') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const kg = getKnowledgeGraph();
        sendJson(res, 200, kg.getProjectSnapshot(projectName));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/knowledge/hot-files') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const limit = Number(url.searchParams.get('limit') || 20);
        const kg = getKnowledgeGraph();
        sendJson(res, 200, kg.getHotFiles(projectName, limit));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/knowledge/fragile') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const kg = getKnowledgeGraph();
        sendJson(res, 200, kg.getFragileAreas(projectName));
        return;
      }

      if (req.method === 'GET' && pathname === '/api/knowledge/decisions') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const kg = getKnowledgeGraph();
        sendJson(res, 200, kg.listDecisions(projectName));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/knowledge/decisions') {
        const body = await readJsonBody(req);
        const projectName = (body.project as string) || getRuntimeConfig().githubRepo;
        const kg = getKnowledgeGraph();
        const id = kg.addDecision({
          projectName,
          title: String(body.title || ''),
          description: String(body.description || ''),
          context: String(body.context || ''),
          affectedPaths: Array.isArray(body.affectedPaths) ? body.affectedPaths : [],
        });
        sendJson(res, 201, { ok: true, id });
        return;
      }

      /* ── Telemetry: Gate Stats ── */

      if (req.method === 'GET' && pathname === '/api/telemetry/gate-stats') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const days = Number(url.searchParams.get('days') || 30);
        const telemetryStore = getTelemetryStore();
        sendJson(res, 200, telemetryStore.getGateStats(projectName, days));
        return;
      }

      /* ── Telemetry: Edit Metrics ── */

      if (req.method === 'GET' && pathname === '/api/telemetry/edit-metrics') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const days = Number(url.searchParams.get('days') || 30);
        const telemetryStore = getTelemetryStore();
        sendJson(res, 200, telemetryStore.getEditMetrics(projectName, days));
        return;
      }

      /* ── Per-Task Cost Breakdown ── */

      if (req.method === 'GET' && extractRunId(pathname, '/task-costs')) {
        const runId = extractRunId(pathname, '/task-costs') as string;
        const telemetryStore = getTelemetryStore();
        sendJson(res, 200, telemetryStore.getTaskCosts(runId));
        return;
      }

      /* ── Knowledge: Module List ── */

      if (req.method === 'GET' && pathname === '/api/knowledge/modules') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const kg = getKnowledgeGraph();
        sendJson(res, 200, kg.listModules(projectName));
        return;
      }

      /* ── Knowledge: API Endpoints ── */

      if (req.method === 'GET' && pathname === '/api/knowledge/api-endpoints') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const kg = getKnowledgeGraph();
        sendJson(res, 200, kg.listApiEndpoints(projectName));
        return;
      }

      /* ── Knowledge: File Change Attribution ── */

      if (req.method === 'GET' && pathname === '/api/knowledge/file-changes') {
        const projectName = url.searchParams.get('project') || getRuntimeConfig().githubRepo;
        const limit = Number(url.searchParams.get('limit') || 50);
        const kg = getKnowledgeGraph();
        sendJson(res, 200, kg.getFileChangesWithAttribution(projectName, limit));
        return;
      }

      /* ── Policy CRUD ── */

      if (req.method === 'GET' && pathname.startsWith('/api/policies/')) {
        const projectName = decodeURIComponent(pathname.slice('/api/policies/'.length));
        sendJson(res, 200, getProjectPolicy(unityStore, projectName));
        return;
      }

      if (req.method === 'PUT' && pathname.startsWith('/api/policies/')) {
        const projectName = decodeURIComponent(pathname.slice('/api/policies/'.length));
        const body = await readJsonBody(req);
        const current = getProjectPolicy(unityStore, projectName);
        const updated = normalizePolicy({ ...current, ...body });
        unityStore.upsertPolicy(projectName, updated);
        sendJson(res, 200, { ok: true, policy: updated });
        return;
      }

      sendJson(res, 404, { error: 'Route not found.' });
    } catch (error: any) {
      sendJson(res, 500, { error: error?.message || 'Unhandled server error.' });
    }
  });

  server.listen(config.localConsolePort, () => {
    console.log(`🌐 Unity Console listening on http://localhost:${config.localConsolePort}`);
  });

  return server;
}
