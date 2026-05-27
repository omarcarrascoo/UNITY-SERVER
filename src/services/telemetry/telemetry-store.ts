/**
 * Telemetry Store — SQLite-backed structured telemetry persistence.
 *
 * Stores typed events with duration, token usage, cost, and metadata.
 * Provides aggregate queries for dashboards and learning.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../../config.js';

export interface TelemetryEvent {
  id: string;
  runId: string;
  taskId: string | null;
  projectName: string;
  event: string;
  durationMs: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensTotal: number | null;
  costUsd: number | null;
  model: string | null;
  status: 'success' | 'failure' | 'warning' | 'info';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface RunCostSummary {
  runId: string;
  projectName: string;
  totalTokens: number;
  totalCostUsd: number;
  taskCount: number;
  avgTokensPerTask: number;
  modelBreakdown: Array<{ model: string; tokens: number; costUsd: number }>;
}

export interface TaskCostEntry {
  taskId: string;
  taskTitle: string | null;
  totalTokens: number;
  costUsd: number;
  model: string | null;
  iterations: number;
  durationMs: number;
}

/**
 * Per-model pricing (USD per 1M tokens), split by input / output / cached-input.
 * Cached input is what the provider discounts for repeated prefix content.
 * Reasoning tokens are billed as output tokens by DeepSeek — no separate row needed.
 */
interface ModelPricing {
  input: number;
  output: number;
  cachedInput: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'deepseek-v4-pro': { input: 0.56, output: 1.68, cachedInput: 0.07 },
  // Legacy aliases so historical rows still resolve a cost.
  'deepseek-reasoner': { input: 0.56, output: 1.68, cachedInput: 0.07 },
  'deepseek-chat': { input: 0.27, output: 1.1, cachedInput: 0.07 },
  'claude-opus-4': { input: 15.0, output: 75.0, cachedInput: 1.5 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cachedInput: 0.3 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cachedInput: 0.1 },
};

const FALLBACK_PRICING: ModelPricing = { input: 1.0, output: 3.0, cachedInput: 0.1 };

export interface TokenBreakdown {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
}

export function estimateCostUsd(model: string | null, breakdown: TokenBreakdown): number {
  if (!model) return 0;
  const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
  const cached = breakdown.cachedPromptTokens ?? 0;
  const billedPrompt = Math.max(0, breakdown.promptTokens - cached);

  return (
    (billedPrompt / 1_000_000) * pricing.input +
    (cached / 1_000_000) * pricing.cachedInput +
    (breakdown.completionTokens / 1_000_000) * pricing.output
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TelemetryStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(DATA_DIR, 'unity-telemetry.sqlite')) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        project_name TEXT NOT NULL,
        event TEXT NOT NULL,
        duration_ms INTEGER,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_total INTEGER,
        cost_usd REAL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'info',
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_telemetry_run ON telemetry(run_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_task ON telemetry(task_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_project ON telemetry(project_name);
      CREATE INDEX IF NOT EXISTS idx_telemetry_event ON telemetry(event);
      CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry(created_at DESC);
    `);
  }

  emit(event: Omit<TelemetryEvent, 'id' | 'createdAt' | 'costUsd'> & { costUsd?: number }): string {
    const id = `tel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cachedPromptTokens = (event.metadata as any)?.cachedPromptTokens ?? 0;
    const costUsd =
      event.costUsd ??
      estimateCostUsd(event.model, {
        promptTokens: event.tokensInput ?? 0,
        completionTokens: event.tokensOutput ?? 0,
        cachedPromptTokens,
      });

    this.db
      .prepare(`
        INSERT INTO telemetry (
          id, run_id, task_id, project_name, event, duration_ms,
          tokens_input, tokens_output, tokens_total, cost_usd,
          model, status, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        event.runId,
        event.taskId ?? null,
        event.projectName,
        event.event,
        event.durationMs ?? null,
        event.tokensInput ?? null,
        event.tokensOutput ?? null,
        event.tokensTotal ?? null,
        costUsd,
        event.model ?? null,
        event.status,
        event.metadata ? JSON.stringify(event.metadata) : null,
        nowIso(),
      );

    return id;
  }

  getRunCostSummary(runId: string): RunCostSummary | null {
    const row = this.db
      .prepare(`
        SELECT
          run_id,
          project_name,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as total_cost_usd,
          COUNT(DISTINCT task_id) as task_count
        FROM telemetry
        WHERE run_id = ? AND tokens_total > 0
        GROUP BY run_id
      `)
      .get(runId) as Record<string, unknown> | undefined;

    if (!row) return null;

    const modelRows = this.db
      .prepare(`
        SELECT
          model,
          SUM(tokens_total) as tokens,
          SUM(cost_usd) as cost_usd
        FROM telemetry
        WHERE run_id = ? AND model IS NOT NULL AND tokens_total > 0
        GROUP BY model
        ORDER BY tokens DESC
      `)
      .all(runId) as Array<Record<string, unknown>>;

    const totalTokens = Number(row.total_tokens) || 0;
    const taskCount = Number(row.task_count) || 1;

    return {
      runId,
      projectName: String(row.project_name),
      totalTokens,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      taskCount,
      avgTokensPerTask: Math.round(totalTokens / taskCount),
      modelBreakdown: modelRows.map((r) => ({
        model: String(r.model),
        tokens: Number(r.tokens) || 0,
        costUsd: Number(r.cost_usd) || 0,
      })),
    };
  }

  getTaskCosts(runId: string): TaskCostEntry[] {
    const rows = this.db
      .prepare(`
        SELECT
          task_id,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as cost_usd,
          MAX(model) as model,
          COUNT(*) as iterations,
          SUM(duration_ms) as duration_ms
        FROM telemetry
        WHERE run_id = ? AND task_id IS NOT NULL AND tokens_total > 0
        GROUP BY task_id
        ORDER BY total_tokens DESC
      `)
      .all(runId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      taskId: String(r.task_id),
      taskTitle: null,
      totalTokens: Number(r.total_tokens) || 0,
      costUsd: Number(r.cost_usd) || 0,
      model: r.model ? String(r.model) : null,
      iterations: Number(r.iterations) || 0,
      durationMs: Number(r.duration_ms) || 0,
    }));
  }

  listEventsByRun(runId: string, limit = 200): TelemetryEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM telemetry WHERE run_id = ? ORDER BY created_at ASC LIMIT ?`)
      .all(runId, limit) as Array<Record<string, unknown>>;

    return rows.map(mapTelemetryEvent);
  }

  getProjectStats(projectName: string, days = 30): {
    totalRuns: number;
    totalTokens: number;
    totalCostUsd: number;
    avgTokensPerRun: number;
    successRate: number;
  } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const row = this.db
      .prepare(`
        SELECT
          COUNT(DISTINCT run_id) as total_runs,
          SUM(tokens_total) as total_tokens,
          SUM(cost_usd) as total_cost_usd,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          COUNT(*) as total_events
        FROM telemetry
        WHERE project_name = ? AND created_at >= ?
      `)
      .get(projectName, cutoff) as Record<string, unknown>;

    const totalRuns = Number(row.total_runs) || 0;
    const totalTokens = Number(row.total_tokens) || 0;
    const successCount = Number(row.success_count) || 0;
    const totalEvents = Number(row.total_events) || 1;

    return {
      totalRuns,
      totalTokens,
      totalCostUsd: Number(row.total_cost_usd) || 0,
      avgTokensPerRun: totalRuns > 0 ? Math.round(totalTokens / totalRuns) : 0,
      successRate: totalEvents > 0 ? successCount / totalEvents : 0,
    };
  }

  /**
   * Gate pass/fail/skip rates aggregated by gate name.
   */
  getGateStats(projectName: string, days = 30): Array<{
    gate: string;
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  }> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(`
        SELECT
          REPLACE(event, 'gate.', '') as gate_name,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as passed,
          SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'info' THEN 1 ELSE 0 END) as skipped,
          COUNT(*) as total
        FROM telemetry
        WHERE project_name = ? AND event LIKE 'gate.%' AND created_at >= ?
        GROUP BY gate_name
        ORDER BY total DESC
      `)
      .all(projectName, cutoff) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      gate: String(r.gate_name),
      passed: Number(r.passed) || 0,
      failed: Number(r.failed) || 0,
      skipped: Number(r.skipped) || 0,
      total: Number(r.total) || 0,
    }));
  }

  /**
   * Edit success/failure/fuzzy-match metrics.
   */
  getEditMetrics(projectName: string, days = 30): {
    applied: number;
    failed: number;
    fuzzyMatches: number;
    total: number;
    successRate: number;
  } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const row = this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN event = 'edit.applied' THEN 1 ELSE 0 END) as applied,
          SUM(CASE WHEN event = 'edit.failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN event = 'edit.applied' AND metadata LIKE '%fuzzy%' THEN 1 ELSE 0 END) as fuzzy,
          COUNT(*) as total
        FROM telemetry
        WHERE project_name = ? AND event LIKE 'edit.%' AND created_at >= ?
      `)
      .get(projectName, cutoff) as Record<string, unknown>;

    const applied = Number(row.applied) || 0;
    const failed = Number(row.failed) || 0;
    const total = applied + failed;

    return {
      applied,
      failed,
      fuzzyMatches: Number(row.fuzzy) || 0,
      total,
      successRate: total > 0 ? applied / total : 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

function mapTelemetryEvent(row: Record<string, unknown>): TelemetryEvent {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: row.task_id ? String(row.task_id) : null,
    projectName: String(row.project_name),
    event: String(row.event),
    durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
    tokensInput: row.tokens_input != null ? Number(row.tokens_input) : null,
    tokensOutput: row.tokens_output != null ? Number(row.tokens_output) : null,
    tokensTotal: row.tokens_total != null ? Number(row.tokens_total) : null,
    costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
    model: row.model ? String(row.model) : null,
    status: String(row.status) as TelemetryEvent['status'],
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : null,
    createdAt: String(row.created_at),
  };
}

/** Singleton */
let instance: TelemetryStore | null = null;

export function getTelemetryStore(): TelemetryStore {
  if (!instance) {
    instance = new TelemetryStore();
  }
  return instance;
}
