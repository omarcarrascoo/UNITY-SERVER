/**
 * Conversation store — persists agent interactions (questions + answers) as
 * conversations with follow-up support, scoped to a project (or 'brainstorm').
 *
 * A conversation = a thread tied to a project (or 'brainstorm' for no-project
 * idea exploration). Messages = the alternating user/agent turns. Follow-ups
 * reuse prior messages as context. Filterable by project, re-readable later.
 *
 * Own SQLite db (`unity-conversations.sqlite`), same pattern as the other stores.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../../config.js';

/** Sentinel project for no-project idea exploration. */
export const BRAINSTORM = 'brainstorm';

export type MessageRole = 'user' | 'agent';

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  /** Which agent answered (for role='agent'); null for user turns. */
  agentId: string | null;
  content: string;
  /** How the agent was chosen ('llm'/'keywords'/'manual'/...) — for agent turns. */
  routedVia: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  /** Project name, or BRAINSTORM. */
  projectName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationWithMessages extends Conversation {
  messages: ConversationMessage[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ConversationStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = path.join(DATA_DIR, 'unity-conversations.sqlite')) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        agent_id TEXT,
        content TEXT NOT NULL,
        routed_via TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_name);
      CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_msg_conv ON conversation_messages(conversation_id, created_at ASC);
    `);
  }

  createConversation(id: string, projectName: string, title: string): Conversation {
    const ts = nowIso();
    const conv: Conversation = { id, projectName: projectName || BRAINSTORM, title: title.slice(0, 120), createdAt: ts, updatedAt: ts };
    this.db
      .prepare(`INSERT INTO conversations (id, project_name, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(conv.id, conv.projectName, conv.title, conv.createdAt, conv.updatedAt);
    return conv;
  }

  addMessage(id: string, msg: Omit<ConversationMessage, 'id' | 'createdAt'>): ConversationMessage {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversation_messages (id, conversation_id, role, agent_id, content, routed_via, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, msg.conversationId, msg.role, msg.agentId, msg.content, msg.routedVia, ts);
    // Touch the conversation's updated_at so lists sort by recent activity.
    this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(ts, msg.conversationId);
    return { id, createdAt: ts, ...msg };
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      projectName: String(row.project_name),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getMessages(conversationId: string): ConversationMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`)
      .all(conversationId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      conversationId: String(r.conversation_id),
      role: String(r.role) as MessageRole,
      agentId: (r.agent_id as string) ?? null,
      content: String(r.content),
      routedVia: (r.routed_via as string) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  getWithMessages(id: string): ConversationWithMessages | null {
    const conv = this.getConversation(id);
    if (!conv) return null;
    return { ...conv, messages: this.getMessages(id) };
  }

  /** List conversations, optionally filtered by project (BRAINSTORM for ideas). */
  listConversations(projectName?: string): Conversation[] {
    const where = projectName ? `WHERE project_name = ?` : '';
    const rows = this.db
      .prepare(`SELECT * FROM conversations ${where} ORDER BY updated_at DESC`)
      .all(...(projectName ? [projectName] : [])) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      projectName: String(row.project_name),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }
}

let instance: ConversationStore | null = null;
export function getConversationStore(): ConversationStore {
  if (!instance) instance = new ConversationStore();
  return instance;
}
