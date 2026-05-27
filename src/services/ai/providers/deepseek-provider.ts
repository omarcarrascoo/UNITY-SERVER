import { createDeepseekChatCompletion } from '../client.js';
import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMToolCall,
  ReasoningEffort,
} from './types.js';

/**
 * DeepSeek provider — wraps the existing client.ts retry logic.
 *
 * For `deepseek-v4-pro`, thinking mode is controlled via the `thinking` flag
 * and `reasoningEffort`. When thinking is enabled the API ignores temperature
 * and sampling penalties, so we omit them to keep the payload clean.
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek';

  isAvailable(): boolean {
    return Boolean(process.env.DEEPSEEK_API_KEY);
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse> {
    const thinkingEnabled = request.thinking === true;
    const reasoningEffort: ReasoningEffort | undefined = thinkingEnabled
      ? request.reasoningEffort ?? 'high'
      : undefined;

    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages as any,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (!thinkingEnabled) {
      payload.temperature = request.temperature ?? 0;
    }

    if (request.tools) {
      payload.tools = request.tools as any;
    }

    if (request.responseFormat) {
      payload.response_format = request.responseFormat;
    }

    if (thinkingEnabled) {
      payload.reasoning_effort = reasoningEffort;
      // OpenAI SDK forwards unknown top-level keys, but the DeepSeek docs
      // specify the thinking toggle must ride along on the request body.
      payload.thinking = { type: 'enabled' };
    } else {
      payload.thinking = { type: 'disabled' };
    }

    const response = await createDeepseekChatCompletion(
      payload as any,
      { signal: request.signal },
    );

    const message: any = response.choices?.[0]?.message;

    if (process.env.DEEPSEEK_DEBUG === '1') {
      const finishReason = response.choices?.[0]?.finish_reason;
      const contentLen = typeof message?.content === 'string' ? message.content.length : 0;
      const reasoningLen = typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0;
      console.log(
        `[deepseek-debug] model=${request.model} thinking=${thinkingEnabled} ` +
          `finish_reason=${finishReason} content_len=${contentLen} reasoning_len=${reasoningLen} ` +
          `usage=${JSON.stringify(response.usage)}`,
      );
      if (contentLen === 0 || contentLen < 20) {
        console.log('[deepseek-debug] full content:', JSON.stringify(message?.content));
      } else {
        console.log('[deepseek-debug] content preview:', String(message.content).slice(0, 400));
      }
    }

    const toolCalls: LLMToolCall[] = (message?.tool_calls || [])
      .filter((tc: any) => tc?.function)
      .map((tc: any) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        },
      }));

    // Preserve the exact reasoning_content the API sent, including empty strings.
    // The DeepSeek API requires the full string (empty or not) to be echoed back on
    // subsequent requests whenever the assistant turn included tool calls.
    const reasoningContent: string | null =
      typeof message?.reasoning_content === 'string'
        ? message.reasoning_content
        : null;

    const usage = response.usage ?? {};
    const cachedPromptTokens =
      (usage as any).prompt_cache_hit_tokens ??
      (usage as any).prompt_tokens_details?.cached_tokens ??
      0;
    const reasoningTokens =
      (usage as any).completion_tokens_details?.reasoning_tokens ?? 0;

    return {
      content: message?.content ?? null,
      toolCalls,
      reasoningContent,
      usage: {
        promptTokens: (usage as any).prompt_tokens ?? 0,
        completionTokens: (usage as any).completion_tokens ?? 0,
        totalTokens: (usage as any).total_tokens ?? 0,
        cachedPromptTokens,
        reasoningTokens,
      },
      raw: response,
    };
  }
}
