/**
 * Agent Router — decides which agent should handle a free-text prompt.
 *
 * Strategy: LLM classifier first (understands intent), deterministic keyword
 * match as a fallback when the LLM is unavailable, errors, or returns an unknown
 * agent id. Always resolves to SOME agent (defaults to dev-squad — the most
 * common case) so the caller never gets nothing.
 *
 * See planning-docs/AGENT_COMPANY_VISION.md §1.
 */
import { roleCompletion } from '../../services/ai/completion.js';
import { listAgents, getAgent, type RegisteredAgent } from './agent-registry.js';

export interface RouteDecision {
  agent: RegisteredAgent;
  /** 'llm' | 'keywords' | 'default' | 'manual' */
  via: string;
  /** Short human-readable reason. */
  reason: string;
}

const DEFAULT_AGENT_ID = 'dev-squad';

/** Deterministic keyword scoring over the registry. Returns best match or null. */
export function routeByKeywords(prompt: string): RouteDecision | null {
  const text = prompt.toLowerCase();
  let best: { agent: RegisteredAgent; score: number; hits: string[] } | null = null;

  for (const agent of listAgents()) {
    const hits = agent.keywords.filter((kw) => text.includes(kw));
    if (hits.length > 0 && (!best || hits.length > best.score)) {
      best = { agent, score: hits.length, hits };
    }
  }

  if (!best) return null;
  return {
    agent: best.agent,
    via: 'keywords',
    reason: `Matched keywords: ${best.hits.slice(0, 4).join(', ')}`,
  };
}

/** LLM classifier. Returns the chosen agent id, or null on failure/unknown. */
async function classifyWithLLM(prompt: string): Promise<{ id: string; reason: string } | null> {
  const agents = listAgents();
  const catalog = agents.map((a) => `- ${a.id}: ${a.capability}`).join('\n');

  try {
    const res = await roleCompletion('repair', {
      messages: [
        {
          role: 'system',
          content:
            `You are a router. Given a user request, choose the single best agent to handle it from this catalog:\n${catalog}\n\n` +
            `Respond with ONLY a JSON object: {"agent":"<id>","reason":"<short reason>"}. ` +
            `The agent MUST be one of the exact ids listed. If unsure, choose "${DEFAULT_AGENT_ID}".`,
        },
        { role: 'user', content: prompt },
      ],
      responseFormat: { type: 'json_object' },
    });

    const content = (res.content || '').trim();
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { agent?: string; reason?: string };
    if (!parsed.agent || !getAgent(parsed.agent)) return null; // unknown id → caller falls back
    return { id: parsed.agent, reason: parsed.reason || 'LLM classification' };
  } catch {
    return null;
  }
}

/**
 * Route a prompt to an agent. LLM first, keyword fallback, default last.
 * `preferLlm: false` skips the LLM (e.g. to avoid token cost in tests).
 */
export async function routePrompt(prompt: string, opts: { preferLlm?: boolean } = {}): Promise<RouteDecision> {
  const preferLlm = opts.preferLlm !== false;

  if (preferLlm) {
    const llm = await classifyWithLLM(prompt);
    if (llm) {
      const agent = getAgent(llm.id)!;
      return { agent, via: 'llm', reason: llm.reason };
    }
  }

  const kw = routeByKeywords(prompt);
  if (kw) return kw;

  // Nothing matched — default to the dev squad (most requests are dev work).
  return {
    agent: getAgent(DEFAULT_AGENT_ID)!,
    via: 'default',
    reason: `No strong signal; defaulted to ${DEFAULT_AGENT_ID}.`,
  };
}

/** Resolve a manually-selected agent id into a decision (no classification). */
export function routeManual(agentId: string): RouteDecision | null {
  const agent = getAgent(agentId);
  if (!agent) return null;
  return { agent, via: 'manual', reason: 'Manually selected.' };
}
