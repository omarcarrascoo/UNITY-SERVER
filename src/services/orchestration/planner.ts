import { roleCompletion } from '../ai/completion.js';
import { parseJsonObject } from '../ai/edit-operations.js';
import type { PlanTaskDraft, RunPlanDraft } from '../../domain/orchestration.js';

interface PlanRunParams {
  prompt: string;
  projectTree: string;
  projectMemory: string | null;
  runId?: string;
  projectName?: string;
}

const ADVISORY_TITLE_PATTERN =
  /^(analy[sz]e|analy[sz]ing|analysis|analizar|revisar|review|inspect|investigate|diagnose|audit|explore)\b/i;

const EXECUTION_VERB_PATTERN =
  /\b(create|implement|fix|update|edit|add|remove|refactor|wire|connect|build|write|modify|repair|redesign|crear|implementar|corregir|actualizar|editar|agregar|eliminar|refactorizar|conectar|modificar|reparar|redisenar|rediseñar)\b/i;

function normalizeWriteScope(writeScope: unknown): string[] {
  if (!Array.isArray(writeScope) || writeScope.length === 0) {
    return ['.'];
  }

  const normalized = writeScope
    .map((scope) => (typeof scope === 'string' ? scope.trim().replace(/^\.?\//, '').replace(/\/+$/, '') : ''))
    .filter(Boolean);

  return normalized.length ? normalized : ['.'];
}

function looksAdvisoryTask(task: Partial<PlanTaskDraft>): boolean {
  const title = (task.title || '').trim();
  const prompt = (task.prompt || '').trim();
  return ADVISORY_TITLE_PATTERN.test(title) && !EXECUTION_VERB_PATTERN.test(`${title} ${prompt}`);
}

function buildExecutionContract(prompt: string, writeScope: string[]): string {
  return `Execution contract:
- Produce concrete code changes, not analysis-only output.
- Prioritize the requested outcome over adjacent cleanup.
- Stay within these write scopes unless a directly-related fix is strictly required: ${writeScope.join(', ')}.
- Do not chase unrelated repo errors outside your scope.
- If you notice unrelated issues, leave them untouched and focus on making this task healthy.

Task instruction:
${prompt}`;
}

function normalizePlanTasks(tasks: Partial<PlanTaskDraft>[], fallbackPrompt: string): PlanTaskDraft[] {
  const fallbackTasks = tasks.map((task, index) => ({
    title: task.title || `Implementation Task ${index + 1}`,
    prompt: task.prompt || fallbackPrompt,
    role: 'executor' as const,
    kind: task.kind || 'implement',
    writeScope: normalizeWriteScope(task.writeScope),
    dependencies: Array.isArray(task.dependencies) ? task.dependencies.filter(Boolean) : [],
    rationale: task.rationale,
  }));

  const executableTasks = fallbackTasks.filter((task) => !looksAdvisoryTask(task));
  const selectedTasks = executableTasks.length > 0 ? executableTasks : fallbackTasks;
  const allowedTitles = new Set(selectedTasks.map((task) => task.title));

  return selectedTasks.map((task, index) => {
    const writeScope = normalizeWriteScope(task.writeScope);

    return {
      ...task,
      title: task.title || `Implementation Task ${index + 1}`,
      prompt: buildExecutionContract(task.prompt || fallbackPrompt, writeScope),
      role: 'executor',
      kind: task.kind || 'implement',
      writeScope,
      dependencies: (task.dependencies || []).filter((dependency) => allowedTitles.has(dependency)),
    };
  });
}

function buildPlannerPrompt({ prompt, projectTree, projectMemory }: PlanRunParams): string {
  return `You are the planner agent of Unity.
Create an execution plan for an autonomous coding system.

PROJECT TREE
${projectTree || '(empty)'}

PROJECT MEMORY
${projectMemory || '(none)'}

USER REQUEST
${prompt}

PLANNING PRINCIPLES
- Decompose the request into the most granular set of independently executable tasks the work naturally affords. If two concerns touch disjoint files with no shared state, they must be separate tasks so the orchestrator can run them in parallel.
- Do not collapse multiple concerns into one mega-task just because they stem from the same user request. Over-bundling breaks mid-execution and forces retries; fine-grained tasks succeed independently and parallelize cleanly.
- A task's writeScope is the exact list of files it will create or modify — use concrete file paths with extensions, never bare directories. If you genuinely cannot name the files yet (e.g. generated code, unknown names), name the parent directory and explain why in rationale.
- writeScope paths MUST be REPO-ROOT-RELATIVE. In a monorepo, include the package prefix (e.g. "kubo-mobile/app/profile.tsx", NOT "app/profile.tsx"). Look at PROJECT TREE above to identify package roots. Getting this wrong causes the scope gate to reject the task even when all edits are correct.
- Group files into the same task only when they form one cohesive unit (e.g. a component and its styles/tests, or a set of co-edited files that share state). There is no hard min or max — let cohesion decide.
- Declare dependencies ONLY when task B needs a file that task A creates, or when B must edit something A introduces. Shared-library refactors that create new APIs consumed by other tasks MUST have explicit deps. Everything else runs in parallel.
- Prefer creating small new files over editing large existing ones when both achieve the goal — new files have no merge risk and parallelize trivially.
- Each task's "prompt" field must be a complete, self-contained instruction: the executor will NOT see the user's original request, only your task prompt. Include the concrete deliverable, any constraints (styling, API contracts, conventions from PROJECT MEMORY), and the exact files to touch (repo-root-relative paths).

FORMAT RULES
- Return strict JSON with double quotes and no trailing commas.
- Do not wrap the JSON in markdown or commentary.
- Task titles must be unique within the plan (dependencies reference them by title).

EXAMPLE (abstract — DO NOT copy verbatim; follow the shape, not the content; notice paths are REPO-ROOT-RELATIVE including the package prefix "mobile-app/"):
{
  "summary": "Add a settings screen with profile, notifications, and theme preferences.",
  "tasks": [
    {
      "title": "Create ThemeToggle component",
      "prompt": "Create mobile-app/src/components/ThemeToggle.tsx — a toggle that reads and writes the current theme via the existing useTheme hook. Follow the existing component conventions (functional component, named export, typed props).",
      "role": "executor",
      "kind": "implement",
      "writeScope": ["mobile-app/src/components/ThemeToggle.tsx"],
      "dependencies": [],
      "rationale": "Reusable control needed by the settings screen; standalone so it parallelizes."
    },
    {
      "title": "Create NotificationPreferences component",
      "prompt": "Create mobile-app/src/components/NotificationPreferences.tsx — renders checkboxes for each notification channel read from the existing notificationChannels config. Persist changes through the existing userPreferences API client.",
      "role": "executor",
      "kind": "implement",
      "writeScope": ["mobile-app/src/components/NotificationPreferences.tsx"],
      "dependencies": [],
      "rationale": "Independent UI block; shares no state with other tasks."
    },
    {
      "title": "Create ProfileForm component",
      "prompt": "Create mobile-app/src/components/ProfileForm.tsx — a form for display name and avatar upload using the existing useUser hook. Validate non-empty display name before submit.",
      "role": "executor",
      "kind": "implement",
      "writeScope": ["mobile-app/src/components/ProfileForm.tsx"],
      "dependencies": [],
      "rationale": "Independent UI block."
    },
    {
      "title": "Assemble settings screen",
      "prompt": "Create mobile-app/src/screens/SettingsScreen.tsx that composes ProfileForm, NotificationPreferences, and ThemeToggle in a scrollable layout. Register the route in mobile-app/src/navigation/routes.ts.",
      "role": "executor",
      "kind": "implement",
      "writeScope": ["mobile-app/src/screens/SettingsScreen.tsx", "mobile-app/src/navigation/routes.ts"],
      "dependencies": ["Create ThemeToggle component", "Create NotificationPreferences component", "Create ProfileForm component"],
      "rationale": "Depends on the three child components existing before it can import them."
    }
  ]
}

Now produce the JSON plan for the USER REQUEST above.`;
}

function hasJsonShape(text: string): boolean {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  return firstBrace !== -1 && lastBrace > firstBrace;
}

async function requestPlan(params: PlanRunParams): Promise<string> {
  const userMessage = { role: 'user' as const, content: buildPlannerPrompt(params) };

  // First pass: honor the role's default (thinking on, json_object).
  const primary = await roleCompletion('planning', {
    messages: [userMessage],
    responseFormat: { type: 'json_object' },
    runId: params.runId,
    projectName: params.projectName,
  });

  const primaryContent = (primary.content || '').trim();
  if (primaryContent && hasJsonShape(primaryContent)) return primaryContent;

  // DeepSeek occasionally returns empty content (or non-JSON prose) under
  // thinking + json_object. Retry with thinking disabled, which is the
  // stable combination the DeepSeek docs recommend for structured output.
  const reason = primaryContent ? 'non-JSON prose' : 'empty content';
  console.warn(
    `⚠️ Planner returned ${reason} under thinking mode. Retrying with thinking disabled.`,
  );

  const fallback = await roleCompletion('planning', {
    messages: [userMessage],
    responseFormat: { type: 'json_object' },
    thinking: false,
    runId: params.runId,
    projectName: params.projectName,
  });

  return (fallback.content || '').trim();
}

export async function planAutonomousRun(params: PlanRunParams): Promise<RunPlanDraft> {
  try {
    const content = await requestPlan(params);
    if (!content) {
      throw new Error('Planner returned empty content after retry.');
    }

    const plan = parseJsonObject<RunPlanDraft>(content);

    if (!plan.tasks?.length) {
      throw new Error('Planner returned no tasks.');
    }

    return {
      summary: plan.summary || 'Autonomous execution plan',
      tasks: normalizePlanTasks(plan.tasks, params.prompt),
    };
  } catch (error) {
    console.error('Planner failed, falling back to single-task plan:', error);

    return {
      summary: 'Fallback single-task autonomous plan',
      tasks: [
        {
          title: 'Primary Implementation',
          prompt: buildExecutionContract(params.prompt, ['.']),
          role: 'executor',
          kind: 'implement',
          writeScope: ['.'],
          dependencies: [],
          rationale: 'Fallback task when planning fails.',
        },
      ],
    };
  }
}
