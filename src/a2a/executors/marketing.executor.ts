/**
 * Marketing Squad executor — first real consumer of the Approval Gateway.
 *
 * Flow: receive a brief → draft a social post (LLM) → emit `input-required` and
 * call the gateway (which surfaces ✅/🗑️ in Discord) → on approval, "publish"
 * (mocked for now); on reject/timeout, cancel. This proves the human-in-the-loop
 * authorization cycle end to end. The Dev Squad does NOT do this — only outward,
 * public actions are gated.
 *
 * The core logic lives in `runMarketingDraft` so triggers (Discord /marketing,
 * panel) can reuse it without going through the A2A server.
 */
import type {
  AgentExecutor,
  RequestContext,
  ExecutionEventBus,
} from '@a2a-js/sdk/server';
import { roleCompletion } from '../../services/ai/completion.js';
import { getApprovalGateway } from '../approval/approval-gateway.js';
import { initialTask, statusUpdate, artifactUpdate, firstText } from '../shared/events.js';

/** Mock "publish" — replace with a real MCP/social client later. */
async function publishPost(_text: string): Promise<string> {
  return `https://social.example/posts/${Date.now().toString(36)}`;
}

export interface MarketingResult {
  status: 'published' | 'rejected' | 'failed';
  draft: string | null;
  publishedUrl?: string;
  detail: string;
}

/**
 * Draft a post, request human approval, and publish on approval. Reusable by the
 * A2A executor AND by direct triggers (Discord command, panel). `onProgress` lets
 * a trigger stream status to its own surface (a Discord thread, etc.).
 */
export async function runMarketingDraft(
  brief: string,
  onProgress?: (message: string) => void | Promise<void>,
): Promise<MarketingResult> {
  const note = async (m: string) => { if (onProgress) await onProgress(m); };

  await note('✍️ Drafting post...');
  let draft = '';
  try {
    const res = await roleCompletion('pr-metadata', {
      messages: [
        {
          role: 'system',
          content:
            'You are a social media writer. Write ONE concise, engaging post (max 280 chars) for the given brief. Return only the post text — no surrounding quotes.',
        },
        { role: 'user', content: brief },
      ],
    });
    draft = (res.content || '').trim();
  } catch (err: any) {
    return { status: 'failed', draft: null, detail: `Drafting failed: ${err?.message || String(err)}` };
  }

  if (!draft) return { status: 'failed', draft: null, detail: 'Could not draft a post.' };

  await note(`📝 Draft ready:\n${draft}\n\n⏳ Requesting approval to publish...`);

  const decision = await getApprovalGateway().requestApproval({
    title: 'Publish this marketing post?',
    detail: draft,
    requestedBy: 'Marketing Squad',
  });

  if (!decision.approved) {
    await note(`🗑️ Not approved (${decision.reason}). Post was NOT published.`);
    return { status: 'rejected', draft, detail: `Not approved (${decision.reason}).` };
  }

  const url = await publishPost(draft);
  await note(`✅ Approved by ${decision.decidedBy || 'human'} — published: ${url}`);
  return { status: 'published', draft, publishedUrl: url, detail: `Published: ${url}` };
}

export class MarketingExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task } = ctx;
    const brief = firstText(userMessage) || 'Announce our latest update.';

    if (!task) bus.publish(initialTask(taskId, contextId, userMessage));
    bus.publish(statusUpdate(taskId, contextId, 'working', false, 'Drafting post...'));

    const result = await runMarketingDraft(brief, (m) => {
      // Map progress to A2A status: the approval wait is the input-required phase.
      const state = m.includes('Requesting approval') ? 'input-required' : 'working';
      bus.publish(statusUpdate(taskId, contextId, state, false, m));
    });

    if (result.draft) {
      bus.publish(artifactUpdate(taskId, contextId, 'draft', result.draft, 'post-draft.txt'));
    }

    if (result.status === 'published') {
      bus.publish(artifactUpdate(taskId, contextId, 'published', result.publishedUrl!, 'published-url.txt'));
      bus.publish(statusUpdate(taskId, contextId, 'completed', true, result.detail));
    } else if (result.status === 'rejected') {
      bus.publish(statusUpdate(taskId, contextId, 'canceled', true, result.detail));
    } else {
      bus.publish(statusUpdate(taskId, contextId, 'failed', true, result.detail));
    }
    bus.finished();
  }

  cancelTask = async (_taskId: string, _bus: ExecutionEventBus): Promise<void> => {};
}
