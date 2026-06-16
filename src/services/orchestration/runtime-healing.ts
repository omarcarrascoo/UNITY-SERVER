/**
 * Runtime healing: turn classified runtime-boot failures into targeted repair
 * tasks that flow through the EXISTING improvement-cycle machinery
 * (createImprovementTasks → executeTask → integrate).
 *
 * Design: planning-docs/RUNTIME_HEALING_DESIGN.md (Part B).
 */
import type { PlanTaskDraft } from '../../domain/orchestration.js';
import type { RuntimeFailure } from './runtime-gate.js';

/** Does a failure kind warrant an automated code-repair task? */
function isAutoFixable(failure: RuntimeFailure): boolean {
  switch (failure.kind) {
    case 'unresolved-module':
    case 'compile-error':
      return true;
    // missing-env: do NOT auto-invent secrets (security rule). port-in-use:
    // environmental, not a code bug. prereq/timeout/unknown: not safely fixable
    // by a scoped code edit.
    default:
      return false;
  }
}

/** Build a scoped write-list for the repair task from the failure's file hint. */
function repairScope(failure: RuntimeFailure): string[] {
  return failure.file ? [failure.file] : ['.'];
}

function buildRepairPrompt(failure: RuntimeFailure): string {
  const base = `The application FAILS TO BOOT in the runtime gate. Fix ONLY what is needed to make it start. Do not refactor unrelated code.`;

  if (failure.kind === 'unresolved-module') {
    return `${base}

Runtime error (service: ${failure.service}):
  ${failure.detail}

The module "${failure.module}" cannot be resolved${failure.file ? ` from ${failure.file}` : ''}.
Resolve it by ONE of:
- Fixing an incorrect import path/specifier (most common: a wrong package scope or a typo). Check how sibling files import the same thing and match exactly.
- If the package genuinely isn't installed and is the correct one, the import is wrong — prefer switching to the already-installed equivalent rather than adding a dependency.
Do not add a new dependency unless it is unquestionably required and correct.

Raw log:
${failure.rawLog}`;
  }

  if (failure.kind === 'compile-error') {
    return `${base}

Runtime/compile error (service: ${failure.service}):
  ${failure.detail}
${failure.file ? `File: ${failure.file}` : ''}

Fix the type/compile error so the project builds and boots. Make the smallest correct change.

Raw log:
${failure.rawLog}`;
  }

  // Generic fallback (only reached if caller includes a non-auto-fixable kind).
  return `${base}

Runtime error (service: ${failure.service}):
  ${failure.detail}

Raw log:
${failure.rawLog}`;
}

function shortTitle(failure: RuntimeFailure): string {
  if (failure.kind === 'unresolved-module') return `Fix unresolved module "${failure.module}" (${failure.service})`;
  if (failure.kind === 'compile-error') return `Fix compile error in ${failure.file ?? failure.service}`;
  return `Fix runtime boot failure (${failure.service})`;
}

/**
 * Convert runtime failures into repair task drafts. Only auto-fixable kinds
 * become tasks; others are skipped (caller decides how to surface them).
 * Deduplicates by (kind, module/file) so repeated log lines don't spawn dupes.
 */
export function buildRuntimeRepairTasks(failures: RuntimeFailure[]): PlanTaskDraft[] {
  const seen = new Set<string>();
  const drafts: PlanTaskDraft[] = [];

  for (const failure of failures) {
    if (!isAutoFixable(failure)) continue;

    const key = `${failure.kind}:${failure.module ?? ''}:${failure.file ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    drafts.push({
      title: shortTitle(failure),
      prompt: buildRepairPrompt(failure),
      role: 'executor',
      kind: 'heal',
      writeScope: repairScope(failure),
      dependencies: [],
      rationale: `Auto-generated to heal a runtime boot failure: ${failure.detail}`,
    });
  }

  return drafts;
}

/** Are any of these failures things we can attempt to auto-heal? */
export function hasHealableFailures(failures: RuntimeFailure[]): boolean {
  return failures.some(isAutoFixable);
}
