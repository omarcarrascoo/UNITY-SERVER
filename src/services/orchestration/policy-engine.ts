import { getRuntimeConfig } from '../../config.js';
import type { AutonomousRunPolicy } from '../../domain/policies.js';
import { UnityStore } from '../persistence/unity-store.js';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function getDefaultAutonomousRunPolicy(): AutonomousRunPolicy {
  return {
    integrationBranchName: getRuntimeConfig().integrationBranchName,
    autoApprovePlan: true,
    maxParallelTasks: 3,
    maxRetriesPerTask: 2,
    maxImprovementCycles: 2,
    maxRuntimeHealCycles: 3,
    maxHours: 1,
    maxCommits: 8,
    maxTokensPerRun: 2_000_000,
    maxTokensPerTask: 500_000,
    maxMinutesPerTask: 30,
    gates: {
      runTypecheck: true,
      runLint: true,
      runTests: true,
      runBuild: true,
      runRuntime: true,
      requireRuntimeForUi: true,
      captureSnapshot: false,
      runSecurityScan: true,
      runImportCycleCheck: true,
    },
  };
}

export function normalizePolicy(policy: AutonomousRunPolicy): AutonomousRunPolicy {
  return {
    ...policy,
    autoApprovePlan: policy.autoApprovePlan ?? true,
    maxParallelTasks: clamp(policy.maxParallelTasks, 1, 6),
    maxRetriesPerTask: clamp(policy.maxRetriesPerTask, 0, 5),
    maxImprovementCycles: clamp(policy.maxImprovementCycles, 0, 4),
    // `?? 3` so policies persisted before this field existed still get healing.
    maxRuntimeHealCycles: clamp(policy.maxRuntimeHealCycles ?? 3, 0, 5),
    maxHours: clamp(policy.maxHours, 1, 4),
    maxCommits: clamp(policy.maxCommits, 1, 50),
    maxTokensPerRun: policy.maxTokensPerRun ?? 2_000_000,
    maxTokensPerTask: policy.maxTokensPerTask ?? 500_000,
    maxMinutesPerTask: clamp(policy.maxMinutesPerTask ?? 30, 5, 120),
  };
}

export function getProjectPolicy(store: UnityStore, projectName: string): AutonomousRunPolicy {
  const stored = store.getPolicy(projectName);
  return normalizePolicy(stored || getDefaultAutonomousRunPolicy());
}

export type PolicyPreset = 'conservative' | 'balanced' | 'aggressive';

const POLICY_PRESETS: Record<PolicyPreset, Partial<AutonomousRunPolicy>> = {
  conservative: {
    maxParallelTasks: 1,
    maxRetriesPerTask: 1,
    maxImprovementCycles: 1,
    maxHours: 1,
    maxCommits: 4,
    maxTokensPerRun: 1_000_000,
    maxTokensPerTask: 250_000,
    maxMinutesPerTask: 20,
    autoApprovePlan: false,
  },
  balanced: {
    maxParallelTasks: 3,
    maxRetriesPerTask: 2,
    maxImprovementCycles: 2,
    maxHours: 2,
    maxCommits: 8,
    maxTokensPerRun: 2_000_000,
    maxTokensPerTask: 500_000,
    maxMinutesPerTask: 30,
    autoApprovePlan: true,
  },
  aggressive: {
    maxParallelTasks: 6,
    maxRetriesPerTask: 3,
    maxImprovementCycles: 4,
    maxHours: 4,
    maxCommits: 25,
    maxTokensPerRun: 5_000_000,
    maxTokensPerTask: 1_000_000,
    maxMinutesPerTask: 45,
    autoApprovePlan: true,
  },
};

export function applyPolicyPreset(
  base: AutonomousRunPolicy,
  preset: PolicyPreset,
): AutonomousRunPolicy {
  return normalizePolicy({ ...base, ...POLICY_PRESETS[preset] });
}

export function isPolicyPreset(value: string): value is PolicyPreset {
  return value === 'conservative' || value === 'balanced' || value === 'aggressive';
}
