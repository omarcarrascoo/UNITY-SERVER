/**
 * Unified completion layer — combines model router, provider registry,
 * and token tracking into a single entry point.
 *
 * Call sites use `roleCompletion(role, request)` instead of
 * directly calling `createDeepseekChatCompletion`. The router
 * picks the model/provider, and token usage is tracked automatically.
 */

import type { AgentRole } from './model-router.js';
import { getModelConfig } from './model-router.js';
import { resolveProvider } from './providers/provider-registry.js';
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMMessage,
  LLMToolDefinition,
  ReasoningEffort,
} from './providers/types.js';
import { getTokenTracker } from './token-tracker.js';
import { getTelemetryStore } from '../telemetry/telemetry-store.js';

export interface RoleCompletionRequest {
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  responseFormat?: { type: 'json_object' };
  signal?: AbortSignal;
  /** Override temperature for this specific call */
  temperature?: number;
  /** Override max tokens for this specific call */
  maxTokens?: number;
  /** Override the role's default thinking toggle for this specific call */
  thinking?: boolean;
  /** Override the role's default reasoning effort for this specific call */
  reasoningEffort?: ReasoningEffort;
  /** For token tracking */
  runId?: string;
  taskId?: string;
  /** Project name for telemetry attribution */
  projectName?: string;
  /** Duration start timestamp (ms) captured by caller if available */
  startedAtMs?: number;
}

/**
 * Execute a completion using the model router.
 * Automatically selects the right model/provider for the given role.
 */
export async function roleCompletion(
  role: AgentRole,
  request: RoleCompletionRequest,
): Promise<LLMCompletionResponse> {
  const config = getModelConfig(role);
  const provider = resolveProvider(config.provider);

  const llmRequest: LLMCompletionRequest = {
    model: config.model,
    messages: request.messages,
    temperature: request.temperature ?? config.temperature,
    maxTokens: request.maxTokens ?? config.maxTokens,
    tools: request.tools,
    responseFormat: request.responseFormat,
    signal: request.signal,
    thinking: request.thinking ?? config.thinking,
    reasoningEffort: request.reasoningEffort ?? config.reasoningEffort,
  };

  const startedAt = request.startedAtMs ?? Date.now();
  const response = await provider.complete(llmRequest);
  const durationMs = Date.now() - startedAt;

  // Persist per-call telemetry so the panel has real cost/token data.
  if (request.runId) {
    try {
      getTelemetryStore().emit({
        runId: request.runId,
        taskId: request.taskId ?? null,
        projectName: request.projectName ?? 'unknown',
        event: `llm.${role}`,
        durationMs,
        tokensInput: response.usage.promptTokens,
        tokensOutput: response.usage.completionTokens,
        tokensTotal: response.usage.totalTokens,
        model: config.model,
        status: 'success',
        metadata: {
          cachedPromptTokens: response.usage.cachedPromptTokens ?? 0,
          reasoningTokens: response.usage.reasoningTokens ?? 0,
          thinking: llmRequest.thinking ?? false,
          reasoningEffort: llmRequest.reasoningEffort ?? null,
        },
      });
    } catch (err) {
      console.warn('Telemetry emit failed (non-fatal):', err);
    }
  }

  // Track token usage and enforce budgets
  if (request.runId) {
    const tracker = getTokenTracker();
    const budgetCheck = tracker.record(request.runId, request.taskId ?? null, response.usage.totalTokens);

    if (budgetCheck.status === 'exceeded') {
      throw new Error(`Token budget exceeded: ${budgetCheck.message || 'Run or task token limit reached.'}`);
    }

    if (budgetCheck.status === 'warning' && budgetCheck.message) {
      console.warn(`⚠️ Token budget: ${budgetCheck.message}`);
    }
  }

  return response;
}
