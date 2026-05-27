/**
 * Model Router — maps agent roles to model configurations.
 *
 * All roles run on the unified `deepseek-v4-pro` model. The separation between
 * reasoning and chat behaviour is now controlled per-request through the
 * thinking toggle and reasoning effort instead of separate model names.
 */

import type { ReasoningEffort } from './providers/types.js';

export type AgentRole =
  | 'planning'
  | 'code-gen'
  | 'review'
  | 'pr-metadata'
  | 'repair'
  | 'explorer'
  | 'architect';

export type ModelTier = 'reasoning' | 'chat' | 'fast';

export interface ModelConfig {
  /** Model identifier (e.g. 'deepseek-v4-pro') */
  model: string;
  /** Provider key for the provider registry */
  provider: string;
  /** Default temperature for this role (ignored when thinking is enabled) */
  temperature: number;
  /** Default max output tokens */
  maxTokens: number;
  /** Model tier classification */
  tier: ModelTier;
  /** Whether to enable the model's thinking pass for this role. */
  thinking: boolean;
  /** Effort budget applied when `thinking` is true. */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Default role-to-model mapping.
 * Reasoning-tier roles run with thinking enabled; chat-tier roles disable it
 * so temperature/penalty knobs still apply.
 */
const DEFAULT_MODEL_MAP: Record<AgentRole, ModelConfig> = {
  'code-gen': {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    temperature: 0.2,
    maxTokens: 120000,
    tier: 'reasoning',
    thinking: true,
    reasoningEffort: 'max',
  },

  'pr-metadata': {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    temperature: 0.4,
    maxTokens: 10000,
    tier: 'chat',
    thinking: false,
  },

  planning: {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    temperature: 0.4,
    maxTokens: 120000,
    tier: 'reasoning',
    thinking: true,
    reasoningEffort: 'high',
  },

  review: {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    temperature: 0,
    maxTokens: 30000,
    tier: 'chat',
    thinking: false,
  },

  repair: {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    temperature: 0,
    maxTokens: 25000,
    tier: 'chat',
    thinking: false,
  },

  explorer: {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    temperature: 0.2,
    maxTokens: 120000,
    tier: 'reasoning',
    thinking: true,
    reasoningEffort: 'high',
  },

  architect: {
    model: 'deepseek-v4-pro',
    provider: 'deepseek',
    temperature: 0.3,
    maxTokens: 120000,
    tier: 'reasoning',
    thinking: true,
    reasoningEffort: 'max',
  },
};

/** Runtime overrides set via `configureModelRouter`. */
let overrides: Partial<Record<AgentRole, Partial<ModelConfig>>> = {};

/**
 * Get the model configuration for a given agent role.
 * Merges any runtime overrides on top of the defaults.
 */
export function getModelConfig(role: AgentRole): ModelConfig {
  const base = DEFAULT_MODEL_MAP[role];
  const override = overrides[role];

  if (!override) return base;

  return { ...base, ...override };
}

/**
 * Apply runtime overrides for one or more roles.
 * Typically called at startup based on env vars or policy.
 */
export function configureModelRouter(
  config: Partial<Record<AgentRole, Partial<ModelConfig>>>,
): void {
  overrides = { ...overrides, ...config };
}

/**
 * Reset all overrides (mainly for testing).
 */
export function resetModelRouter(): void {
  overrides = {};
}

/**
 * List all current model configurations (defaults + overrides).
 */
export function listModelConfigs(): Record<AgentRole, ModelConfig> {
  const roles: AgentRole[] = ['planning', 'code-gen', 'review', 'pr-metadata', 'repair', 'explorer', 'architect'];
  const result = {} as Record<AgentRole, ModelConfig>;
  for (const role of roles) {
    result[role] = getModelConfig(role);
  }
  return result;
}
