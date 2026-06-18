/**
 * Market Research executor — a routable analysis agent.
 *
 * Takes a topic and returns a concise market analysis via the LLM. No approval
 * needed (it produces information, not an outward public action). Core logic in
 * `runMarketResearch` so triggers (router, panel, Discord) can reuse it.
 *
 * Future: also FILE tickets with findings (AGENT_COMPANY_VISION.md §5).
 */
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from '@a2a-js/sdk/server';
import { roleCompletion } from '../../services/ai/completion.js';
import { initialTask, statusUpdate, artifactUpdate, firstText } from '../shared/events.js';

export interface MarketResearchResult {
  status: 'done' | 'failed';
  analysis: string | null;
  detail: string;
}

export async function runMarketResearch(
  topic: string,
  onProgress?: (message: string) => void | Promise<void>,
): Promise<MarketResearchResult> {
  const note = async (m: string) => { if (onProgress) await onProgress(m); };
  await note('🔎 Researching the market...');

  try {
    const res = await roleCompletion('planning', {
      messages: [
        {
          role: 'system',
          content:
            'You are a market research analyst. Given a topic, produce a CONCISE analysis (under 400 words) covering: market overview, key competitors, trends, and 2-3 concrete opportunities. Use clear headers and bullet points.',
        },
        { role: 'user', content: topic },
      ],
    });
    const analysis = (res.content || '').trim();
    if (!analysis) return { status: 'failed', analysis: null, detail: 'No analysis produced.' };
    await note('✅ Analysis ready.');
    return { status: 'done', analysis, detail: 'Market analysis complete.' };
  } catch (err: any) {
    return { status: 'failed', analysis: null, detail: `Research failed: ${err?.message || String(err)}` };
  }
}

export class MarketResearchExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const topic = firstText(userMessage) || 'our product market';

    if (!task) bus.publish(initialTask(taskId, contextId, userMessage));
    bus.publish(statusUpdate(taskId, contextId, 'working', false, 'Researching...'));

    const result = await runMarketResearch(topic, (m) =>
      bus.publish(statusUpdate(taskId, contextId, 'working', false, m)),
    );

    if (result.status === 'done' && result.analysis) {
      bus.publish(artifactUpdate(taskId, contextId, 'analysis', result.analysis, 'market-analysis.md'));
      bus.publish(statusUpdate(taskId, contextId, 'completed', true, result.detail));
    } else {
      bus.publish(statusUpdate(taskId, contextId, 'failed', true, result.detail));
    }
    bus.finished();
  }

  cancelTask = async (_taskId: string, _bus: ExecutionEventBus): Promise<void> => {};
}
