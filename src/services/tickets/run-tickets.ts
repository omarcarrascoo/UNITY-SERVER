/**
 * Auto-tickets from autonomous runs.
 *
 * One `auto` ticket per run, kept in sync with the run lifecycle so the board
 * reflects what the agents are doing without anyone creating tickets by hand.
 * Best-effort: never throws into the run loop (ticket failures must not break a run).
 */
import { createEntityId } from '../../shared/ids.js';
import { getTicketStore, type TicketStatus } from './ticket-store.js';
import { notifyTicketChange } from './ticket-notifier.js';

/** Map a run status → a board status. */
function runStatusToTicket(runStatus: string): TicketStatus {
  switch (runStatus) {
    case 'completed':
      return 'done';
    case 'completed_with_warnings':
      return 'done'; // done, but the description notes the warnings
    case 'failed':
    case 'plan_rejected':
    case 'cancelled':
      return 'blocked';
    case 'running':
    case 'healing':
    case 'planning':
    case 'awaiting_plan_approval':
    default:
      return 'in_progress';
  }
}

/** Create the run's ticket when the run starts (idempotent — skips if it exists). */
export function openRunTicket(params: {
  runId: string;
  projectName: string;
  prompt: string;
}): void {
  try {
    const store = getTicketStore();
    if (store.getByRun(params.runId)) return; // already exists (resume)
    const title = params.prompt.trim().replace(/\s+/g, ' ').slice(0, 80) || `Run ${params.runId}`;
    const ticket = store.create(createEntityId('ticket'), {
      title,
      description: params.prompt,
      status: 'in_progress',
      source: 'auto',
      projectName: params.projectName,
      runId: params.runId,
      tags: ['run'],
    });
    notifyTicketChange({ ticket, kind: 'created' });
  } catch (err) {
    console.warn('openRunTicket failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/** Move the run's ticket to its terminal board status when the run closes. */
export function closeRunTicket(params: {
  runId: string;
  runStatus: string;
  summary?: string | null;
}): void {
  try {
    const store = getTicketStore();
    const ticket = store.getByRun(params.runId);
    if (!ticket) return;
    const newStatus = runStatusToTicket(params.runStatus);
    if (ticket.status === newStatus) return;
    const updated = store.update(ticket.id, {
      status: newStatus,
      description: params.summary ? `${ticket.description}\n\n— Outcome (${params.runStatus}):\n${params.summary.slice(0, 1000)}` : ticket.description,
    });
    if (updated) notifyTicketChange({ ticket: updated, kind: 'status', fromStatus: ticket.status });
  } catch (err) {
    console.warn('closeRunTicket failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}
