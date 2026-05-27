/**
 * Multi-Repo Orchestration — coordinate autonomous runs across multiple repositories.
 *
 * Supports:
 * - Cross-repo task dependencies (backend API change → frontend client update)
 * - Coordinated PRs (one per repo, linked together)
 * - Repo-aware planning (planner can split work across repos)
 * - Unified integration branch strategy per repo
 */

import { getProjectByName, getRuntimeConfig } from '../../config.js';
import type { WorkspaceProject } from '../../domain/runtime.js';
import type { PlanTaskDraft, RunPlanDraft, TaskRecord } from '../../domain/orchestration.js';
import { unityStore } from '../../runtime/services.js';
import { createEntityId } from '../../shared/ids.js';
import { roleCompletion } from '../ai/completion.js';
import { parseJsonObject } from '../ai/edit-operations.js';
import { getProjectTree, getProjectMemory } from '../../scanner.js';

/* ── Types ── */

export interface RepoDescriptor {
  name: string;
  role: 'backend' | 'frontend' | 'shared' | 'infra';
  description: string;
}

export interface MultiRepoConfig {
  repos: RepoDescriptor[];
  contractFiles?: string[];
}

export interface MultiRepoPlan {
  summary: string;
  repoPlans: Array<{
    repoName: string;
    tasks: PlanTaskDraft[];
    crossRepoDependencies: Array<{
      taskTitle: string;
      dependsOnRepo: string;
      dependsOnTask: string;
      reason: string;
    }>;
  }>;
  coordinatedPrs: Array<{
    repoName: string;
    prTitle: string;
    linkedRepos: string[];
  }>;
}

export interface MultiRepoRunState {
  runId: string;
  repos: Map<string, {
    project: WorkspaceProject;
    subRunId: string | null;
    status: 'pending' | 'running' | 'completed' | 'failed';
    prUrl: string | null;
  }>;
  crossDependencies: Array<{
    sourceRepo: string;
    sourceTask: string;
    targetRepo: string;
    targetTask: string;
  }>;
}

/* ── Multi-Repo Planner ── */

function buildMultiRepoPlannerPrompt(params: {
  prompt: string;
  repos: Array<{ name: string; role: string; tree: string; memory: string | null }>;
}): string {
  const repoSections = params.repos
    .map(
      (repo) => `
### Repository: ${repo.name} (${repo.role})
Tree:
${repo.tree}
${repo.memory ? `\nProject rules:\n${repo.memory}` : ''}`,
    )
    .join('\n---\n');

  return `You are the multi-repo planner agent of Unity.
Create an execution plan that spans multiple repositories.

${repoSections}

USER REQUEST
${params.prompt}

GOALS
- Identify which repositories need changes.
- Create tasks scoped to individual repos with clear write scopes.
- Define cross-repo dependencies when one repo's changes require another's to be done first.
  For example: backend API changes must be done before frontend client updates.
- Each task must specify which repo it belongs to.
- Prefer parallelism within each repo and across repos when safe.

RETURN JSON ONLY:
{
  "summary": "multi-repo plan summary",
  "repoPlans": [
    {
      "repoName": "repo-name",
      "tasks": [
        {
          "title": "task title",
          "prompt": "full task instruction",
          "role": "executor",
          "kind": "implement",
          "writeScope": ["path/in/repo"],
          "dependencies": [],
          "rationale": "why"
        }
      ],
      "crossRepoDependencies": [
        {
          "taskTitle": "task that depends on another repo",
          "dependsOnRepo": "other-repo",
          "dependsOnTask": "task in other repo",
          "reason": "why this dependency exists"
        }
      ]
    }
  ],
  "coordinatedPrs": [
    {
      "repoName": "repo-name",
      "prTitle": "PR title",
      "linkedRepos": ["other-repo"]
    }
  ]
}`;
}

export async function planMultiRepoRun(params: {
  prompt: string;
  repos: RepoDescriptor[];
}): Promise<MultiRepoPlan> {
  const repoContexts = params.repos.map((repo) => {
    const project = getProjectByName(repo.name);
    return {
      name: repo.name,
      role: repo.role,
      tree: getProjectTree(project.repoPath),
      memory: getProjectMemory(project.repoPath),
    };
  });

  try {
    const userMessage = {
      role: 'user' as const,
      content: buildMultiRepoPlannerPrompt({
        prompt: params.prompt,
        repos: repoContexts,
      }),
    };

    let response = await roleCompletion('planning', {
      messages: [userMessage],
      responseFormat: { type: 'json_object' },
    });

    if (!(response.content || '').trim()) {
      console.warn('⚠️ Multi-repo planner returned empty content under thinking mode. Retrying with thinking disabled.');
      response = await roleCompletion('planning', {
        messages: [userMessage],
        responseFormat: { type: 'json_object' },
        thinking: false,
      });
    }

    const content = response.content || '';
    const plan = parseJsonObject<MultiRepoPlan>(content);

    if (!plan.repoPlans?.length) {
      throw new Error('Multi-repo planner returned no repo plans.');
    }

    return {
      summary: plan.summary || 'Multi-repo execution plan',
      repoPlans: plan.repoPlans.map((rp) => ({
        repoName: rp.repoName,
        tasks: (rp.tasks || []).map((t) => ({
          title: t.title || 'Unnamed task',
          prompt: t.prompt || params.prompt,
          role: 'executor' as const,
          kind: t.kind || 'implement',
          writeScope: Array.isArray(t.writeScope) ? t.writeScope : ['.'],
          dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
          rationale: t.rationale,
        })),
        crossRepoDependencies: rp.crossRepoDependencies || [],
      })),
      coordinatedPrs: plan.coordinatedPrs || [],
    };
  } catch (error) {
    console.error('Multi-repo planner failed, falling back to single-repo per task:', error);

    return {
      summary: 'Fallback: each repo gets a single implementation task',
      repoPlans: params.repos.map((repo) => ({
        repoName: repo.name,
        tasks: [
          {
            title: `Implement in ${repo.name}`,
            prompt: params.prompt,
            role: 'executor' as const,
            kind: 'implement' as const,
            writeScope: ['.'],
            dependencies: [],
            rationale: `Fallback task for ${repo.name}`,
          },
        ],
        crossRepoDependencies: [],
      })),
      coordinatedPrs: [],
    };
  }
}

/* ── Cross-Repo Dependency Resolution ── */

/**
 * Given a multi-repo plan, determine the execution order across repos.
 * Returns a topologically sorted list of (repoName, taskTitle) pairs.
 */
export function resolveMultiRepoExecutionOrder(
  plan: MultiRepoPlan,
): Array<{ repoName: string; taskTitle: string; phase: number }> {
  // Build full dependency graph
  const allTasks: Array<{ repoName: string; taskTitle: string; deps: string[] }> = [];

  for (const repoPlan of plan.repoPlans) {
    const crossDeps = new Map<string, string[]>();

    for (const dep of repoPlan.crossRepoDependencies) {
      const key = dep.taskTitle;
      const depKey = `${dep.dependsOnRepo}::${dep.dependsOnTask}`;
      if (!crossDeps.has(key)) crossDeps.set(key, []);
      crossDeps.get(key)!.push(depKey);
    }

    for (const task of repoPlan.tasks) {
      const intraRepoDeps = (task.dependencies || []).map((d) => `${repoPlan.repoName}::${d}`);
      const crossRepoDeps = crossDeps.get(task.title) || [];

      allTasks.push({
        repoName: repoPlan.repoName,
        taskTitle: task.title,
        deps: [...intraRepoDeps, ...crossRepoDeps],
      });
    }
  }

  // Topological sort by phases (Kahn's algorithm)
  const taskKey = (repoName: string, title: string) => `${repoName}::${title}`;
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const task of allTasks) {
    const key = taskKey(task.repoName, task.taskTitle);
    inDegree.set(key, 0);
    adjList.set(key, []);
  }

  for (const task of allTasks) {
    const key = taskKey(task.repoName, task.taskTitle);
    for (const dep of task.deps) {
      if (adjList.has(dep)) {
        adjList.get(dep)!.push(key);
        inDegree.set(key, (inDegree.get(key) || 0) + 1);
      }
    }
  }

  const result: Array<{ repoName: string; taskTitle: string; phase: number }> = [];
  let phase = 0;
  let queue = allTasks
    .filter((t) => (inDegree.get(taskKey(t.repoName, t.taskTitle)) || 0) === 0)
    .map((t) => taskKey(t.repoName, t.taskTitle));

  while (queue.length > 0) {
    const nextQueue: string[] = [];

    for (const key of queue) {
      const [repoName, ...titleParts] = key.split('::');
      const taskTitle = titleParts.join('::');
      result.push({ repoName, taskTitle, phase });

      for (const neighbor of adjList.get(key) || []) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) nextQueue.push(neighbor);
      }
    }

    phase++;
    queue = nextQueue;
  }

  return result;
}

/* ── Coordinated PR Description ── */

export function buildCoordinatedPrBody(params: {
  repoName: string;
  linkedRepos: string[];
  linkedPrUrls: Map<string, string>;
  planSummary: string;
}): string {
  const linkedSection = params.linkedRepos
    .map((repo) => {
      const url = params.linkedPrUrls.get(repo);
      return url ? `- **${repo}**: ${url}` : `- **${repo}**: (PR pending)`;
    })
    .join('\n');

  return `## Multi-Repo Change

This PR is part of a coordinated change across multiple repositories.

### Plan
${params.planSummary}

### Linked PRs
${linkedSection}

> ⚠️ These PRs should be reviewed and merged together to maintain cross-repo consistency.

---
🤖 Generated by Unity Agent (multi-repo orchestration)`;
}

/* ── Multi-Repo Config Loading ── */

/**
 * Load multi-repo config from `.unity/repos.json` in the workspace directory.
 * Returns null if not configured.
 */
export function loadMultiRepoConfig(): MultiRepoConfig | null {
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(getRuntimeConfig().dataDir, 'repos.json');

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw) as MultiRepoConfig;
    if (!config.repos?.length) return null;
    return config;
  } catch {
    return null;
  }
}
