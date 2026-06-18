/**
 * Route + dispatch orchestration — the entry point both the Discord `/ask`
 * command and the panel use. Picks an agent (auto via router, or manual), then
 * dispatches the prompt and returns a summary.
 *
 * Now PROJECT-AWARE and CONVERSATIONAL: every interaction is persisted to a
 * conversation (scoped to the active project, or 'brainstorm'), and follow-ups
 * reuse prior turns as context so the agent remembers what we were discussing.
 *
 * Special case: the Dev Squad is NOT prompt-dispatchable (it needs the full
 * autonomous-run flow: workspace + planning + worktrees). So when routing lands
 * on dev-squad, we DON'T dispatch over A2A — we tell the caller to use the normal
 * autonomous-run path instead.
 */
import { routePrompt, routeManual, type RouteDecision } from './agent-router.js';
import { dispatchPrompt } from '../clients/agent-client.js';
import { getConversationStore, BRAINSTORM } from '../../services/conversations/conversation-store.js';
import { createEntityId } from '../../shared/ids.js';

export interface RouteRunResult {
  decision: RouteDecision;
  /** 'dispatched' | 'needs-autonomous-run' | 'failed' */
  outcome: 'dispatched' | 'needs-autonomous-run' | 'failed';
  terminalState?: string | null;
  output?: string | null;
  detail: string;
  /** The conversation this interaction was recorded in (for follow-ups + history). */
  conversationId: string;
}

export interface RouteOptions {
  /** Manually-chosen agent id (skips classification). */
  manualAgentId?: string;
  /** Active project, or undefined/'brainstorm' for no-project idea exploration. */
  projectName?: string;
  /** Existing conversation to continue (follow-up). Omit to start a new one. */
  conversationId?: string;
  onProgress?: (m: string) => void | Promise<void>;
}

const MAX_CONTEXT_TURNS = 6;

/** Build a context-enriched prompt from prior conversation turns (for follow-ups). */
function buildContextualPrompt(conversationId: string, prompt: string): string {
  const store = getConversationStore();
  const prior = store.getMessages(conversationId);
  if (prior.length === 0) return prompt;

  const recent = prior.slice(-MAX_CONTEXT_TURNS);
  const transcript = recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  return `Earlier in this conversation:\n${transcript}\n\nFollow-up question: ${prompt}\n\nAnswer the follow-up using the context above.`;
}

/**
 * Route a prompt (auto) or use a manually-chosen agent, then dispatch — persisting
 * the interaction to a project-scoped conversation. Follow-ups (conversationId set)
 * carry prior turns as context.
 */
export async function routeAndDispatch(prompt: string, opts: RouteOptions = {}): Promise<RouteRunResult> {
  const store = getConversationStore();
  const projectName = opts.projectName?.trim() || BRAINSTORM;

  // Resolve / create the conversation this interaction belongs to.
  let conversationId = opts.conversationId || '';
  const isFollowUp = Boolean(conversationId && store.getConversation(conversationId));
  if (!isFollowUp) {
    conversationId = createEntityId('conv');
    store.createConversation(conversationId, projectName, prompt);
  }

  // Record the user's turn.
  store.addMessage(createEntityId('msg'), {
    conversationId, role: 'user', agentId: null, content: prompt, routedVia: null,
  });

  const decision = opts.manualAgentId ? routeManual(opts.manualAgentId) : await routePrompt(prompt);
  if (!decision) {
    const detail = `Unknown agent: ${opts.manualAgentId}`;
    store.addMessage(createEntityId('msg'), { conversationId, role: 'agent', agentId: null, content: detail, routedVia: 'error' });
    return { decision: { agent: { id: 'unknown' } as any, via: 'manual', reason: 'unknown agent' }, outcome: 'failed', detail, conversationId };
  }

  await opts.onProgress?.(`🧭 Routed to **${decision.agent.name}** (${decision.via}: ${decision.reason})`);

  // Dev Squad needs the full autonomous-run pipeline — signal the caller.
  if (!decision.agent.acceptsPrompt) {
    const detail = `${decision.agent.name} handles this via an autonomous run (workspace + planning), not a direct prompt. Launch a run with this prompt${projectName !== BRAINSTORM ? ` on ${projectName}` : ''}.`;
    store.addMessage(createEntityId('msg'), { conversationId, role: 'agent', agentId: decision.agent.id, content: detail, routedVia: decision.via });
    return { decision, outcome: 'needs-autonomous-run', detail, conversationId };
  }

  try {
    // For follow-ups, enrich the prompt with prior turns so the agent has context.
    const effectivePrompt = isFollowUp ? buildContextualPrompt(conversationId, prompt) : prompt;
    const result = await dispatchPrompt(decision.agent.url, effectivePrompt, opts.onProgress);
    const answer = result.artifactText || `(${decision.agent.name} finished: ${result.terminalState ?? 'unknown'})`;
    store.addMessage(createEntityId('msg'), { conversationId, role: 'agent', agentId: decision.agent.id, content: answer, routedVia: decision.via });
    return {
      decision,
      outcome: 'dispatched',
      terminalState: result.terminalState,
      output: result.artifactText,
      detail: `${decision.agent.name} finished: ${result.terminalState ?? 'unknown'}.`,
      conversationId,
    };
  } catch (err: any) {
    const detail = `Dispatch to ${decision.agent.name} failed: ${err?.message || String(err)}`;
    store.addMessage(createEntityId('msg'), { conversationId, role: 'agent', agentId: decision.agent.id, content: detail, routedVia: 'error' });
    return { decision, outcome: 'failed', detail, conversationId };
  }
}
