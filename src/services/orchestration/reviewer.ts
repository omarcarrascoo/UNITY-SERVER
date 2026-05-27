import { roleCompletion } from '../ai/completion.js';
import { parseJsonObject } from '../ai/edit-operations.js';
import type { GateResult, PlanTaskDraft, ReviewFinding, ReviewResult } from '../../domain/orchestration.js';

interface ReviewTaskParams {
  runPrompt: string;
  taskTitle: string;
  taskPrompt: string;
  diff: string;
  gateResults: GateResult[];
  runId?: string;
  taskId?: string;
  projectName?: string;
}

interface PartialReviewResult {
  approved?: unknown;
  summary?: unknown;
  findings?: unknown;
  followUpTasks?: unknown;
}

function getGateByName(gateResults: GateResult[], name: string): GateResult | undefined {
  return gateResults.find((gate) => gate.name === name);
}

function shouldApproveFromGates(gateResults: GateResult[]): boolean {
  const scopeGate = getGateByName(gateResults, 'scope');
  if (scopeGate?.status === 'failed') {
    return false;
  }

  const baselineDeltaGate = getGateByName(gateResults, 'baseline-delta');
  if (baselineDeltaGate?.status === 'failed') {
    return false;
  }

  return true;
}

function normalizeWriteScope(writeScope: unknown): string[] {
  if (!Array.isArray(writeScope) || writeScope.length === 0) {
    return ['.'];
  }

  const normalized = writeScope
    .map((scope) => (typeof scope === 'string' ? scope.trim().replace(/^\.?\//, '').replace(/\/+$/, '') : ''))
    .filter(Boolean);

  return normalized.length ? normalized : ['.'];
}

function normalizeDependencies(dependencies: unknown): string[] {
  if (!Array.isArray(dependencies)) {
    return [];
  }

  return dependencies
    .map((dependency) => (typeof dependency === 'string' ? dependency.trim() : ''))
    .filter(Boolean);
}

function normalizeFinding(finding: unknown): ReviewFinding | null {
  if (!finding || typeof finding !== 'object') {
    return null;
  }

  const record = finding as Record<string, unknown>;
  const severity =
    record.severity === 'high' || record.severity === 'medium' || record.severity === 'low'
      ? record.severity
      : 'low';
  const message = typeof record.message === 'string' ? record.message.trim() : '';

  if (!message) {
    return null;
  }

  const normalized: ReviewFinding = {
    severity,
    message,
  };

  if (typeof record.file === 'string' && record.file.trim()) {
    normalized.file = record.file.trim();
  }

  return normalized;
}

function normalizeFollowUpTask(task: unknown): PlanTaskDraft | null {
  if (!task || typeof task !== 'object') {
    return null;
  }

  const record = task as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';

  if (!title || !prompt) {
    return null;
  }

  const kind =
    record.kind === 'implement' || record.kind === 'improve' || record.kind === 'heal'
      ? record.kind
      : 'improve';

  return {
    title,
    prompt,
    role: 'executor',
    kind,
    writeScope: normalizeWriteScope(record.writeScope),
    dependencies: normalizeDependencies(record.dependencies),
    rationale: typeof record.rationale === 'string' ? record.rationale.trim() : undefined,
  };
}

function coerceReviewResult(review: PartialReviewResult): ReviewResult {
  return {
    approved: Boolean(review.approved),
    summary:
      typeof review.summary === 'string' && review.summary.trim()
        ? review.summary.trim()
        : 'Review completed.',
    findings: Array.isArray(review.findings)
      ? review.findings.map(normalizeFinding).filter((finding): finding is ReviewFinding => Boolean(finding))
      : [],
    followUpTasks: Array.isArray(review.followUpTasks)
      ? review.followUpTasks
          .map(normalizeFollowUpTask)
          .filter((task): task is PlanTaskDraft => Boolean(task))
      : [],
  };
}

function parseReviewResponse(content: string): ReviewResult {
  return coerceReviewResult(parseJsonObject<PartialReviewResult>(content));
}

async function repairReviewResponse(
  rawContent: string,
  attribution?: { runId?: string; taskId?: string; projectName?: string },
): Promise<ReviewResult> {
  const response = await roleCompletion('repair', {
    responseFormat: { type: 'json_object' },
    runId: attribution?.runId,
    taskId: attribution?.taskId,
    projectName: attribution?.projectName,
    messages: [
      {
        role: 'user',
        content: `Normalize the following reviewer output into one strict JSON object.
Return JSON only.

Required shape:
{
  "approved": true,
  "summary": "short review summary",
  "findings": [
    { "severity": "low|medium|high", "message": "finding", "file": "optional/file.ts" }
  ],
  "followUpTasks": [
    {
      "title": "optional improvement task",
      "prompt": "executor prompt",
      "role": "executor",
      "kind": "implement|improve|heal",
      "writeScope": ["path"],
      "dependencies": [],
      "rationale": "why"
    }
  ]
}

Reviewer output:
${rawContent || '(empty)'}`,
      },
    ],
  });

  return parseReviewResponse(response.content || '');
}

function extractChangedFiles(diff: string): string[] {
  return Array.from(
    new Set(
      diff
        .split('\n')
        .filter((line) => line.startsWith('+++ b/'))
        .map((line) => line.replace('+++ b/', '').trim())
        .filter((filePath) => filePath && filePath !== '/dev/null'),
    ),
  );
}

function buildDeterministicFallbackReview(params: ReviewTaskParams): ReviewResult {
  const approved = shouldApproveFromGates(params.gateResults);
  const findings: ReviewFinding[] = [];
  const changedFiles = extractChangedFiles(params.diff);
  const failedGates = params.gateResults.filter((gate) => gate.status === 'failed');

  for (const gate of failedGates) {
    const severity =
      gate.name === 'scope' || gate.name === 'baseline-delta'
        ? 'high'
        : gate.name === 'runtime'
          ? 'medium'
          : 'low';

    findings.push({
      severity,
      message: `${gate.name} gate failed: ${gate.details}`,
    });
  }

  if (changedFiles.length > 8) {
    findings.push({
      severity: 'low',
      message: `Task touched ${changedFiles.length} files. Consider splitting future work into smaller slices.`,
    });
  }

  if (/\b(TODO|FIXME|HACK)\b/.test(params.diff)) {
    findings.push({
      severity: 'low',
      message: 'Diff contains TODO/FIXME/HACK markers that may need cleanup before merge.',
    });
  }

  const authoritativeSummary = approved
    ? 'Approved by authoritative deterministic gates.'
    : 'Rejected by authoritative deterministic gates.';
  const failedGateSummary = failedGates.length
    ? ` Failed gates: ${failedGates.map((gate) => gate.name).join(', ')}.`
    : ' No authoritative gate failures detected.';
  const changedFilesSummary = changedFiles.length
    ? ` Changed files: ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? ', ...' : ''}.`
    : '';

  return {
    approved,
    summary: `${authoritativeSummary}${failedGateSummary}${changedFilesSummary}`.trim(),
    findings,
    followUpTasks: [],
  };
}

const REVIEW_DIFF_BUDGET = 24000;

function formatDiffForReview(diff: string): { body: string; truncated: boolean; originalLen: number } {
  const originalLen = diff.length;
  if (originalLen <= REVIEW_DIFF_BUDGET) {
    return { body: diff, truncated: false, originalLen };
  }
  return {
    body: `${diff.substring(0, REVIEW_DIFF_BUDGET)}\n\n[DIFF TRUNCATED — showed first ${REVIEW_DIFF_BUDGET} of ${originalLen} chars. Remainder omitted for prompt size only; this is NOT missing code.]`,
    truncated: true,
    originalLen,
  };
}

function buildReviewPrompt({ runPrompt, taskTitle, taskPrompt, diff, gateResults }: ReviewTaskParams): string {
  const { body: diffBody, truncated, originalLen } = formatDiffForReview(diff);
  const truncationNote = truncated
    ? `\n\nDIFF-TRUNCATION NOTICE\nThe diff shown below is truncated at ${REVIEW_DIFF_BUDGET} chars (full diff is ${originalLen} chars). The full patch WAS applied and already passed compile gates. Truncation is ONLY for prompt size — do NOT treat it as missing/incomplete code and do NOT reject the task for "truncated" or "incomplete diff". Trust the GATES results for authoritative status.`
    : '';

  return `You are the reviewer agent of Unity.
Your job is to produce a narrative review of this autonomous task result: a short summary,
findings, and optional follow-up improvement tasks.

APPROVAL DECISION IS NOT YOURS
The approval verdict (approved: true/false) is decided DETERMINISTICALLY by the authoritative
gates (scope + baseline-delta) and will OVERRIDE whatever you return in the "approved" field.
You still must include "approved" in the JSON for schema compatibility, but the system will
replace it. Do not spend effort debating approval — focus on the narrative value you add.

Tasks are SUBTASKS produced by a planner that decomposed the run goal into parallel,
independently shippable units. The executor only received the TASK INSTRUCTION below — not
the full run goal. Review the diff against the TASK INSTRUCTION, not the run goal. The run
goal is provided only as background context to resolve ambiguity. Sibling subtasks handle the
other parts of the run goal — do NOT treat their absence here as a problem.

RUN GOAL (background context only — not the acceptance criteria)
${runPrompt}

TASK TITLE
${taskTitle}

TASK INSTRUCTION (authoritative acceptance criteria — review against this)
${taskPrompt}

GATES (authoritative — already determined approval outcome)
${gateResults.map((gate) => `- ${gate.name}: ${gate.status} -> ${gate.details}`).join('\n')}

NARRATIVE RULES
- Summarize what the diff actually changed in 1-3 sentences. Cite specific file paths.
- List findings only when they add information a reader cannot get from the gate output alone
  (e.g. code smells, risky patterns, missed edge cases inside the task scope).
- A gate that was already failing in baseline is NOT a finding — baseline-delta already
  certified it is pre-existing. Do not restate pre-existing failures as findings.
- Propose follow-up tasks only for real, actionable improvements. Leave the array empty if
  there is nothing worth doing.
- NEVER comment on diff truncation. Truncation is a prompt-size constraint, not a code
  problem — the full patch already compiled.${truncationNote}

DIFF
\`\`\`diff
${diffBody}
\`\`\`

Return JSON only (the "approved" field will be replaced by the deterministic verdict):
{
  "approved": true,
  "summary": "short narrative summary of what the diff changed",
  "findings": [
    { "severity": "low|medium|high", "message": "finding", "file": "optional/file.ts" }
  ],
  "followUpTasks": [
    {
      "title": "optional improvement task",
      "prompt": "executor prompt",
      "role": "executor",
      "kind": "improve",
      "writeScope": ["path"],
      "dependencies": [],
      "rationale": "why"
    }
  ]
}`;
}

export async function reviewTaskResult(params: ReviewTaskParams): Promise<ReviewResult> {
  if (!params.diff.trim()) {
    return {
      approved: true,
      summary: 'No diff generated by task.',
      findings: [],
      followUpTasks: [],
    };
  }

  let rawReviewerContent = '';

  try {
    const response = await roleCompletion('review', {
      responseFormat: { type: 'json_object' },
      runId: params.runId,
      taskId: params.taskId,
      projectName: params.projectName,
      messages: [{ role: 'user', content: buildReviewPrompt(params) }],
    });

    rawReviewerContent = response.content || '';
    const parsed = parseReviewResponse(rawReviewerContent);
    return {
      ...parsed,
      approved: shouldApproveFromGates(params.gateResults),
    };
  } catch (error) {
    console.error('Reviewer primary pass failed, attempting repair:', error);
  }

  try {
    if (!rawReviewerContent.trim()) {
      throw new Error('Reviewer returned no parseable content for repair.');
    }

    const repairReview = await repairReviewResponse(rawReviewerContent, {
      runId: params.runId,
      taskId: params.taskId,
      projectName: params.projectName,
    });
    return {
      ...repairReview,
      approved: shouldApproveFromGates(params.gateResults),
      summary: `Repaired reviewer output. ${repairReview.summary}`,
    };
  } catch (error) {
    console.error('Reviewer failed, falling back to deterministic review:', error);
    return buildDeterministicFallbackReview(params);
  }
}
