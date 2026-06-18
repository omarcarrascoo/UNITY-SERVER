/**
 * Human Approval Gateway.
 *
 * A SELECTIVE capability (not a universal gate): only outward, irreversible,
 * public-facing actions call `requestApproval()` — primarily the Marketing Squad
 * before posting to accounts/ads. The Dev Squad does NOT use this; its human
 * control point is the panel's Create-PR button.
 *
 * Design: an agent (possibly in another process, via A2A `input-required`) asks
 * for approval; the gateway surfaces ✅/🗑️ buttons in Discord and returns a
 * promise that resolves when the human clicks (or rejects/expires). The gateway
 * is transport-agnostic: it doesn't import discord.js. A "notifier" (registered
 * by the Discord layer) is responsible for actually posting the buttons.
 */
import { randomUUID } from 'crypto';

export interface ApprovalRequest {
  /** What needs approving, shown to the human. */
  title: string;
  /** Longer detail (the post body, the ad spend, etc.). */
  detail: string;
  /** Which agent/squad is asking. */
  requestedBy: string;
  /** Optional structured payload echoed back on resolve (for the caller). */
  payload?: Record<string, unknown>;
  /** How long to wait before auto-rejecting (ms). Default 10 min. */
  timeoutMs?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  /** 'human' | 'timeout' | 'no-notifier' */
  reason: string;
  decidedBy?: string;
}

interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A notifier surfaces the approval to a human and is told the approval id so the
 * UI can wire ✅/🗑️ back to `resolve(id, ...)`. Registered by the Discord layer.
 * Returns void; resolution happens later via `resolve()`.
 */
export type ApprovalNotifier = (id: string, request: ApprovalRequest) => void | Promise<void>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

class ApprovalGateway {
  private readonly pending = new Map<string, PendingApproval>();
  private notifier: ApprovalNotifier | null = null;

  /** The Discord layer (or any UI) registers how to surface approvals. */
  setNotifier(notifier: ApprovalNotifier): void {
    this.notifier = notifier;
  }

  /**
   * Request human approval. Resolves when the human decides, or auto-rejects on
   * timeout. If no notifier is registered, fails closed (approved=false) so an
   * unconfigured system never silently performs a gated action.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const id = `appr_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ApprovalDecision>((resolve) => {
      if (!this.notifier) {
        resolve({ approved: false, reason: 'no-notifier' });
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ approved: false, reason: 'timeout' });
      }, timeoutMs);

      this.pending.set(id, { id, request, resolve, timer });

      // Surface to the human. If the notifier throws, fail closed.
      Promise.resolve(this.notifier(id, request)).catch((err) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          resolve({ approved: false, reason: `notifier-error: ${err?.message || String(err)}` });
        }
      });
    });
  }

  /** Resolve a pending approval (called by the Discord button handler). No-op if unknown/already resolved. */
  resolve(id: string, approved: boolean, decidedBy = 'human'): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve({ approved, reason: 'human', decidedBy });
    return true;
  }

  /** For UI: look up a pending request (e.g. to render its title on the button message). */
  get(id: string): ApprovalRequest | null {
    return this.pending.get(id)?.request ?? null;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

let singleton: ApprovalGateway | null = null;

export function getApprovalGateway(): ApprovalGateway {
  if (!singleton) singleton = new ApprovalGateway();
  return singleton;
}
