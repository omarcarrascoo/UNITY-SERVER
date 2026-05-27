/**
 * Provider abstraction types.
 *
 * All LLM providers implement the LLMProvider interface,
 * allowing the system to swap between DeepSeek, Anthropic, OpenAI, etc.
 */

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LLMToolCall[];
  /**
   * Assistant-only. Chain-of-thought from a thinking-mode model.
   * Must be echoed back into subsequent requests when the turn involved a tool call.
   */
  reasoning_content?: string;
}

export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Effort level for thinking-mode models. Providers may map low/medium to high. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface LLMCompletionRequest {
  model: string;
  messages: LLMMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: LLMToolDefinition[];
  responseFormat?: { type: 'json_object' };
  signal?: AbortSignal;
  /**
   * Enable the model's thinking/reasoning pass before the final answer.
   * When true, temperature/top_p/penalty params are ignored by the provider.
   */
  thinking?: boolean;
  /** Effort budget for the thinking pass. Only applied when `thinking` is true. */
  reasoningEffort?: ReasoningEffort;
}

export interface LLMCompletionResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  /** Chain-of-thought emitted by the model in thinking mode, if any. */
  reasoningContent?: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Cached prompt tokens (billed at a reduced rate by most providers). */
    cachedPromptTokens?: number;
    /** Reasoning/thinking tokens included in completionTokens (billed as output). */
    reasoningTokens?: number;
  };
  /** Raw provider-specific response for edge cases */
  raw?: unknown;
}

export interface LLMProvider {
  readonly name: string;

  /**
   * Send a completion request to the provider.
   * Handles retries internally.
   */
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;

  /**
   * Check if this provider is configured (API key available, etc).
   */
  isAvailable(): boolean;
}
