/**
 * In-process run-event bus.
 *
 * Every run/task lifecycle event already funnels through `UnityStore.addEvent`,
 * which persists it to SQLite. This bus lets in-process consumers (notably the
 * SSE endpoint in `transports/http/sse.ts`) observe those events live, without
 * polling the database.
 *
 * Design: a plain `Set` of listeners with synchronous fan-out — the same idiom
 * the codebase already uses elsewhere. `publish` wraps each listener in its own
 * try/catch so a slow or throwing subscriber can NEVER break `addEvent`, which
 * sits on the hot path of every run.
 *
 * Scope: in-memory, per-process. The autonomous run currently executes in the
 * same process that serves the HTTP console, so its events reach this bus. If
 * runs are later moved to a separate process, a cross-process fan-in (IPC/Redis)
 * would be required — out of scope for now.
 */

import type { RunEventRecord } from '../../domain/orchestration.js';

export type RunEventListener = (event: RunEventRecord) => void;

class RunEventBus {
  private listeners = new Set<RunEventListener>();

  /** Subscribe to every published run event. Returns an unsubscribe function. */
  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fan an event out to all listeners. A failing listener never affects others. */
  publish(event: RunEventRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[event-bus] listener threw:', err);
      }
    }
  }

  /** Current subscriber count — handy for diagnostics / health checks. */
  get size(): number {
    return this.listeners.size;
  }
}

export const runEventBus = new RunEventBus();
