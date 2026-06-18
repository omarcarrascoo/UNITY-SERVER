/**
 * Ticket change notifier — decoupled from Discord (no discord.js import here).
 * The Discord layer registers a sink; ticket lifecycle code calls
 * `notifyTicketChange(...)`. If no sink is registered, it's a silent no-op.
 *
 * Same pattern as the Approval Gateway notifier, so tickets can announce
 * meaningful transitions (→done, →blocked) to Discord without coupling layers.
 */
import type { Ticket } from './ticket-store.js';

export interface TicketChange {
  ticket: Ticket;
  /** What happened: 'created' | 'status' | 'updated' | 'deleted'. */
  kind: 'created' | 'status' | 'updated' | 'deleted';
  /** Previous status when kind === 'status'. */
  fromStatus?: string;
}

export type TicketSink = (change: TicketChange) => void | Promise<void>;

let sink: TicketSink | null = null;

export function setTicketSink(s: TicketSink): void {
  sink = s;
}

export function notifyTicketChange(change: TicketChange): void {
  if (!sink) return;
  // Fire-and-forget; never let notification failure break ticket ops.
  Promise.resolve(sink(change)).catch((err) => {
    console.warn('Ticket notify failed (non-fatal):', err?.message || err);
  });
}
