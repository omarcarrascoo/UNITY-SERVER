/**
 * In-house ticket store — a minimal "Jira" for traceability, owned entirely by
 * brain-station (no external Slack/Jira). Tickets come from TWO sources:
 *   - `auto`   : created/updated by the autonomous run lifecycle (a run → a ticket)
 *   - `manual` : created by a human in the panel / mobile app
 *
 * Backed by its own SQLite db (`unity-tickets.sqlite`), same pattern as the other
 * stores (DatabaseSync + WAL). The panel and the mobile app consume it via the
 * REST API in the HTTP server.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../../config.js';

export type TicketStatus = 'backlog' | 'todo' | 'in_progress' | 'done' | 'blocked';
export type TicketSource = 'auto' | 'manual';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export const TICKET_STATUSES: TicketStatus[] = ['backlog', 'todo', 'in_progress', 'done', 'blocked'];
export const TICKET_PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Higher number = picked first by future autonomous self-tasking. */
export const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  source: TicketSource;
  priority: TicketPriority;
  projectName: string | null;
  /** Links to the run/task that spawned an auto ticket (null for manual). */
  runId: string | null;
  taskId: string | null;
  assignee: string | null;
  /** Free tags, comma-joined in storage. */
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateTicketInput {
  title: string;
  description?: string;
  status?: TicketStatus;
  source?: TicketSource;
  priority?: TicketPriority;
  projectName?: string | null;
  runId?: string | null;
  taskId?: string | null;
  assignee?: string | null;
  tags?: string[];
}

export interface TicketFilter {
  status?: TicketStatus;
  source?: TicketSource;
  projectName?: string;
  runId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ''),
    status: String(row.status) as TicketStatus,
    source: String(row.source) as TicketSource,
    priority: (String(row.priority || 'normal')) as TicketPriority,
    projectName: (row.project_name as string) ?? null,
    runId: (row.run_id as string) ?? null,
    taskId: (row.task_id as string) ?? null,
    assignee: (row.assignee as string) ?? null,
    tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class TicketStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(DATA_DIR, 'unity-tickets.sqlite')) {
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
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo',
        source TEXT NOT NULL DEFAULT 'manual',
        priority TEXT NOT NULL DEFAULT 'normal',
        project_name TEXT,
        run_id TEXT,
        task_id TEXT,
        assignee TEXT,
        tags TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_source ON tickets(source);
      CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_name);
      CREATE INDEX IF NOT EXISTS idx_tickets_run ON tickets(run_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at DESC);
    `);

    // Migration: add `priority` to tables created before it existed.
    const cols = this.db.prepare(`PRAGMA table_info(tickets)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'priority')) {
      this.db.exec(`ALTER TABLE tickets ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
    }
  }

  create(id: string, input: CreateTicketInput): Ticket {
    const ts = nowIso();
    const ticket: Ticket = {
      id,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'todo',
      source: input.source ?? 'manual',
      priority: input.priority ?? 'normal',
      projectName: input.projectName ?? null,
      runId: input.runId ?? null,
      taskId: input.taskId ?? null,
      assignee: input.assignee ?? null,
      tags: input.tags ?? [],
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO tickets (id, title, description, status, source, priority, project_name, run_id, task_id, assignee, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticket.id, ticket.title, ticket.description, ticket.status, ticket.source, ticket.priority,
        ticket.projectName, ticket.runId, ticket.taskId, ticket.assignee,
        ticket.tags.join(','), ticket.createdAt, ticket.updatedAt,
      );
    return ticket;
  }

  get(id: string): Ticket | null {
    const row = this.db.prepare(`SELECT * FROM tickets WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToTicket(row) : null;
  }

  /** Find the auto ticket for a run (one ticket per run). */
  getByRun(runId: string): Ticket | null {
    const row = this.db
      .prepare(`SELECT * FROM tickets WHERE run_id = ? AND source = 'auto' ORDER BY created_at ASC LIMIT 1`)
      .get(runId) as Record<string, unknown> | undefined;
    return row ? rowToTicket(row) : null;
  }

  list(filter: TicketFilter = {}): Ticket[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.source) { clauses.push('source = ?'); params.push(filter.source); }
    if (filter.projectName) { clauses.push('project_name = ?'); params.push(filter.projectName); }
    if (filter.runId) { clauses.push('run_id = ?'); params.push(filter.runId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM tickets ${where} ORDER BY updated_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToTicket);
  }

  /** Patch fields. Returns the updated ticket, or null if not found. */
  update(id: string, patch: Partial<Omit<Ticket, 'id' | 'createdAt'>>): Ticket | null {
    const current = this.get(id);
    if (!current) return null;
    const merged: Ticket = { ...current, ...patch, id: current.id, createdAt: current.createdAt, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE tickets SET title=?, description=?, status=?, source=?, priority=?, project_name=?, run_id=?, task_id=?, assignee=?, tags=?, updated_at=? WHERE id=?`,
      )
      .run(
        merged.title, merged.description, merged.status, merged.source, merged.priority, merged.projectName,
        merged.runId, merged.taskId, merged.assignee, merged.tags.join(','), merged.updatedAt, id,
      );
    return merged;
  }

  delete(id: string): boolean {
    const res = this.db.prepare(`DELETE FROM tickets WHERE id = ?`).run(id);
    return res.changes > 0;
  }

  /** Counts per status — for the board header / stats. */
  countsByStatus(projectName?: string): Record<TicketStatus, number> {
    const counts = { backlog: 0, todo: 0, in_progress: 0, done: 0, blocked: 0 } as Record<TicketStatus, number>;
    const where = projectName ? `WHERE project_name = ?` : '';
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) c FROM tickets ${where} GROUP BY status`)
      .all(...(projectName ? [projectName] : [])) as Array<{ status: string; c: number }>;
    for (const r of rows) {
      if (r.status in counts) counts[r.status as TicketStatus] = r.c;
    }
    return counts;
  }
}

let instance: TicketStore | null = null;

export function getTicketStore(): TicketStore {
  if (!instance) instance = new TicketStore();
  return instance;
}
