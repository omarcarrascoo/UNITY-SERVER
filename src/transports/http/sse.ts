/**
 * Server-Sent Events (SSE) stream for live run/task updates.
 *
 * Subscribes to the in-process `runEventBus` (fed by `UnityStore.addEvent`) and
 * pushes each `RunEventRecord` to the client as it is committed — no polling.
 *
 *   GET /api/runs/:id/stream  → events for one run
 *   GET /api/stream           → global firehose (all runs)
 *
 * Resume support: a reconnecting client may send `Last-Event-ID` (header) or
 * `?lastEventId=` (query). For a per-run stream we replay everything committed
 * after that id from the store, so no events are missed across reconnects /
 * app backgrounding. Unknown id → no replay (the client already holds a REST
 * baseline from GET /api/runs/:id).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RunEventRecord } from '../../domain/orchestration.js';
import { runEventBus } from '../../services/events/event-bus.js';
import { unityStore } from '../../runtime/services.js';

const HEARTBEAT_MS = 15_000;

function writeEvent(res: ServerResponse, e: RunEventRecord): void {
  if (res.writableEnded) return;
  // `data` must be single-line; JSON.stringify guarantees no raw newlines.
  res.write(`id: ${e.id}\n`);
  res.write(`event: ${e.type}\n`);
  res.write(`data: ${JSON.stringify(e)}\n\n`);
}

export function handleRunStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { runId?: string },
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // defeat proxy buffering
  });
  res.flushHeaders?.();

  // Prompt the client's onopen to fire even before the first real event.
  res.write(': connected\n\n');

  // ── Replay missed events (per-run only) ────────────────────────────────
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const lastEventId =
      (req.headers['last-event-id'] as string | undefined) ||
      url.searchParams.get('lastEventId') ||
      undefined;

    if (opts.runId && lastEventId) {
      const history = unityStore.listEventsByRun(opts.runId);
      const idx = history.findIndex((e) => e.id === lastEventId);
      if (idx >= 0) {
        for (const e of history.slice(idx + 1)) writeEvent(res, e);
      }
      // Unknown id → replay nothing; client has its REST baseline.
    }
  } catch (err) {
    // Replay is best-effort. Never fall through to the outer JSON-500 handler —
    // headers are already sent and a JSON body would corrupt the stream.
    console.error('[sse] replay failed:', err);
  }

  // ── Live subscription ───────────────────────────────────────────────────
  const off = runEventBus.subscribe((e) => {
    if (!opts.runId || e.runId === opts.runId) writeEvent(res, e);
  });

  // ── Heartbeat (keeps the socket and intermediaries alive) ─────────────────
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  // ── Cleanup on disconnect (prevents bus listener leaks) ───────────────────
  const teardown = () => {
    clearInterval(heartbeat);
    off();
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };
  req.on('close', teardown);
  res.on('error', teardown);
}
