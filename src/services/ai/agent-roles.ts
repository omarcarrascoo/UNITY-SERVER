/**
 * Multi-Agent Specialization — role-based tool sets, prompts, and dispatch.
 *
 * Splits the monolithic code-gen agent into specialized agents:
 *
 *   Explorer   → understands the codebase (read-only tools)
 *   Architect  → designs the approach (no tools, pure reasoning)
 *   Implementer → writes code (existing code-gen agent, scoped tools)
 *   Reviewer   → validates results (existing reviewer, no tools)
 *
 * The pipeline is: Explorer → Architect → Implementer (→ Reviewer handled separately)
 */

import { exec } from 'child_process';
import util from 'util';
import { roleCompletion } from './completion.js';
import { detectSpiralPattern, measureInformationGain, countUniqueFilesRead } from './loop-heuristics.js';
import type { LLMMessage } from './providers/types.js';
import { createAgentToolRuntime, agentTools } from '../../tools.js';
import { getKnowledgeGraph } from '../knowledge/index.js';

const execPromise = util.promisify(exec);

/* ── Tool Set Definitions ── */

/** Read-only tools for the Explorer agent */
const EXPLORER_TOOLS = [
  'read_file',
  'grep_code',
  'search_project',
  'list_directory',
  'find_references',
  'run_command',
] as const;

/** Implementation tools for the Implementer agent */
const IMPLEMENTER_TOOLS = [
  'read_file',
  'grep_code',
  'search_project',
  'write_file',
  'run_tests',
  'run_command',
] as const;

type ToolName = (typeof EXPLORER_TOOLS)[number] | (typeof IMPLEMENTER_TOOLS)[number];

function filterTools(allowedNames: readonly ToolName[]) {
  const nameSet = new Set<string>(allowedNames);
  return agentTools.filter((t) => nameSet.has(t.function.name));
}

/* ── Prompt Templates ── */

function buildExplorerPrompt(params: {
  userPrompt: string;
  projectTree: string;
  projectMemory: string | null;
  projectName: string;
  writeScope: string[];
}): string {
  const scopeNote = params.writeScope.length
    ? `Focus your exploration on these scopes: ${params.writeScope.join(', ')}`
    : 'Explore broadly to understand the relevant codebase areas.';

  let knowledgeSection = '';
  try {
    const kg = getKnowledgeGraph();
    const context = kg.buildPromptContext(params.projectName);
    if (context) {
      knowledgeSection = `\nPROJECT KNOWLEDGE (from previous runs)\n${context}\n`;
    }
  } catch {
    // Knowledge graph not available
  }

  return `You are the Explorer agent — your job is to deeply understand the codebase before any code is written.

PROJECT TREE
${params.projectTree || '(empty)'}

${params.projectMemory ? `PROJECT RULES (.unityrc.md)\n${params.projectMemory}\n` : ''}${knowledgeSection}
USER OBJECTIVE
"${params.userPrompt}"

YOUR MISSION
${scopeNote}

Produce a structured exploration report with:
1. **Entry points**: The key files that need to be modified or created
2. **Patterns discovered**: How similar features are implemented in this codebase
3. **Dependencies**: What modules/imports the target files depend on
4. **Risks**: Potential issues or conflicts with existing code
5. **Recommended approach**: A 2-3 sentence summary of the best implementation strategy

RULES
- Use tools to read files, search for patterns, and understand the architecture
- DO NOT modify any files — you are read-only
- Be thorough but efficient — stop once you have enough context
- Focus on the specific area needed for the task, don't map the entire codebase
- Each tool call must have a clear purpose explained in your message

When you have gathered enough context, return a JSON object:
{
  "entryPoints": ["file1.ts", "file2.ts"],
  "patterns": "Description of relevant patterns found",
  "dependencies": ["module1", "module2"],
  "risks": "Any risks or conflicts identified",
  "approach": "Recommended implementation strategy",
  "keySnippets": { "file.ts": "relevant code section" }
}`;
}

function buildArchitectPrompt(params: {
  userPrompt: string;
  projectTree: string;
  explorationReport: ExplorationReport;
  writeScope: string[];
}): string {
  const scopeStr = params.writeScope.join(', ') || '(unrestricted)';

  return `You are the Architect agent — your job is to design the precise implementation plan.

PROJECT TREE
${params.projectTree || '(empty)'}

USER OBJECTIVE
"${params.userPrompt}"

WRITE SCOPE
${scopeStr}

EXPLORATION REPORT (from the Explorer agent)
Entry points: ${params.explorationReport.entryPoints.join(', ')}
Patterns: ${params.explorationReport.patterns}
Dependencies: ${params.explorationReport.dependencies.join(', ')}
Risks: ${params.explorationReport.risks}
Approach: ${params.explorationReport.approach}
${Object.entries(params.explorationReport.keySnippets || {})
  .map(([file, snippet]) => `\nKey snippet from ${file}:\n\`\`\`\n${String(snippet).substring(0, 800)}\n\`\`\``)
  .join('\n')}

YOUR MISSION
Design the exact implementation plan. Be specific about:
1. Which files to create or modify (and in what order)
2. What patterns to follow (based on the exploration report)
3. What the key code changes look like (pseudo-code or structure)
4. What to watch out for (risks, edge cases)

Return a JSON object:
{
  "plan": "Step-by-step implementation plan",
  "fileChanges": [
    {
      "file": "path/to/file.ts",
      "action": "create" | "modify",
      "description": "What to change and why",
      "pattern": "The code pattern to follow"
    }
  ],
  "testStrategy": "How to verify the implementation",
  "commitMessage": "Suggested commit message"
}`;
}

/* ── Types ── */

export interface ExplorationReport {
  entryPoints: string[];
  patterns: string;
  dependencies: string[];
  risks: string;
  approach: string;
  keySnippets: Record<string, string>;
}

export interface ArchitectPlan {
  plan: string;
  fileChanges: Array<{
    file: string;
    action: 'create' | 'modify';
    description: string;
    pattern?: string;
  }>;
  testStrategy: string;
  commitMessage: string;
}

export interface AgentPipelineResult {
  explorationReport: ExplorationReport;
  architectPlan: ArchitectPlan;
  implementerContext: string;
  totalTokens: number;
}

/* ── Agent Runners ── */

export async function runExplorerAgent(params: {
  repoPath: string;
  userPrompt: string;
  projectTree: string;
  projectMemory: string | null;
  projectName?: string;
  writeScope: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  runId?: string;
  taskId?: string;
}): Promise<{ report: ExplorationReport; tokensUsed: number }> {
  const toolRuntime = createAgentToolRuntime(params.repoPath);
  const explorerTools = filterTools(EXPLORER_TOOLS as unknown as ToolName[]);

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: buildExplorerPrompt({
        userPrompt: params.userPrompt,
        projectTree: params.projectTree,
        projectMemory: params.projectMemory,
        projectName: params.projectName || '',
        writeScope: params.writeScope,
      }),
    },
    { role: 'user', content: `Explore the codebase for: ${params.userPrompt}` },
  ];

  let totalTokens = 0;
  const maxLoops = 30;
  const explorerToolHistory: string[] = [];

  for (let loop = 1; loop <= maxLoops; loop++) {
    if (params.signal?.aborted) throw new Error('AbortError');

    params.onProgress?.(`🔍 Explorer iteration ${loop}...`);

    const response = await roleCompletion('explorer', {
      messages,
      tools: explorerTools as any,
      signal: params.signal,
      runId: params.runId,
      taskId: params.taskId,
      projectName: params.projectName,
    });

    totalTokens += response.usage.totalTokens;
    const content = response.content?.trim() || '';
    const toolCalls = response.toolCalls;

    messages.push({
      role: 'assistant',
      content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(toolCalls.length && typeof response.reasoningContent === 'string'
        ? { reasoning_content: response.reasoningContent }
        : {}),
    });

    if (toolCalls.length) {
      // Record tool descriptors for spiral detection
      for (const toolCall of toolCalls) {
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          explorerToolHistory.push(`${toolCall.function.name}:${args.filepath || args.pattern || args.keyword || args.symbol || ''}`);
        } catch {
          explorerToolHistory.push(`${toolCall.function.name}:`);
        }
      }

      // Spiral detection: if Explorer is stuck, force it to produce report
      const isSpiral = detectSpiralPattern(explorerToolHistory);
      const gain = measureInformationGain(explorerToolHistory);
      const shouldExit = isSpiral || (loop >= 15 && gain === 'stale' && countUniqueFilesRead(explorerToolHistory) >= 2);

      if (shouldExit) {
        // Skip tool execution and ask for the report
        for (const tc of toolCalls) {
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: '[Skipped — produce your exploration report now]' });
        }
        messages.push({
          role: 'user',
          content: 'You are repeating the same exploration patterns. You have enough context. Return your exploration report as a JSON object NOW with: entryPoints, patterns, dependencies, risks, approach, keySnippets.',
        });
        params.onProgress?.(`⚠️ Explorer spiral detected at iteration ${loop}, forcing report.`);
        continue;
      }

      for (const toolCall of toolCalls) {
        let result = '';
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          params.onProgress?.(`🔍 Explorer: ${toolCall.function.name} → ${args.filepath || args.pattern || args.keyword || args.symbol || ''}`);
          result = await toolRuntime.executeTool(toolCall.function.name, args);
        } catch (error: any) {
          result = `Tool error: ${error?.message || String(error)}`;
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, name: toolCall.function.name, content: result });
      }
      continue;
    }

    // Try to parse the exploration report
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const report = JSON.parse(jsonMatch[0]) as ExplorationReport;
        if (report.entryPoints && report.approach) {
          return { report: normalizeExplorationReport(report), tokensUsed: totalTokens };
        }
      }
    } catch {
      // Not valid JSON yet, ask for it
    }

    messages.push({
      role: 'user',
      content: 'Please return your exploration report as a JSON object with the required fields: entryPoints, patterns, dependencies, risks, approach, keySnippets.',
    });
  }

  // Fallback: attempt keyword-based file search before returning empty
  const fallbackEntryPoints = await findEntryPointsByKeywords(params.repoPath, params.userPrompt);

  return {
    report: {
      entryPoints: fallbackEntryPoints,
      patterns: fallbackEntryPoints.length > 0
        ? `Explorer reached iteration limit but keyword search found ${fallbackEntryPoints.length} candidate file(s).`
        : 'Explorer reached iteration limit without producing a report.',
      dependencies: [],
      risks: 'Exploration incomplete — entry points found via keyword fallback.',
      approach: fallbackEntryPoints.length > 0
        ? `Start by reading: ${fallbackEntryPoints.join(', ')}`
        : 'Proceed with direct implementation.',
      keySnippets: {},
    },
    tokensUsed: totalTokens,
  };
}

/**
 * Keyword-based file search fallback when Explorer returns 0 entry points.
 * Extracts meaningful keywords from the task prompt and searches for matching files.
 */
async function findEntryPointsByKeywords(repoPath: string, userPrompt: string): Promise<string[]> {
  try {
    // Extract keywords: words 4+ chars, lowercased, deduplicated, skip common stop words
    const stopWords = new Set([
      'that', 'this', 'with', 'from', 'have', 'will', 'should', 'would', 'could',
      'make', 'create', 'update', 'implement', 'change', 'modify', 'ensure', 'need',
      'also', 'must', 'using', 'into', 'when', 'where', 'what', 'which', 'their',
      'them', 'been', 'being', 'each', 'some', 'more', 'only', 'very', 'than',
      'then', 'just', 'about', 'after', 'before', 'between', 'through', 'during',
    ]);

    const keywords = [...new Set(
      userPrompt
        .replace(/[^a-zA-Z0-9_\-/.]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !stopWords.has(w.toLowerCase()))
        .map((w) => w.toLowerCase()),
    )].slice(0, 6); // Max 6 keywords

    if (keywords.length === 0) return [];

    const entryPoints = new Set<string>();

    for (const keyword of keywords) {
      try {
        // Search for files with the keyword in their name
        const { stdout: fileResults } = await execPromise(
          `find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) -ipath "*${keyword}*" | head -5`,
          { cwd: repoPath, timeout: 5000 },
        );
        for (const line of fileResults.split('\n').filter(Boolean)) {
          entryPoints.add(line.replace(/^\.\//, ''));
        }

        // If file name search didn't find enough, search file contents
        if (entryPoints.size < 3) {
          const { stdout: grepResults } = await execPromise(
            `grep -rl --include="*.ts" --include="*.tsx" -i "${keyword}" . | head -3`,
            { cwd: repoPath, timeout: 5000 },
          );
          for (const line of grepResults.split('\n').filter(Boolean)) {
            entryPoints.add(line.replace(/^\.\//, ''));
          }
        }
      } catch {
        // Individual keyword search failed — continue with others
      }

      if (entryPoints.size >= 8) break; // Enough candidates
    }

    return Array.from(entryPoints).slice(0, 8);
  } catch {
    return [];
  }
}

function normalizeExplorationReport(raw: Partial<ExplorationReport>): ExplorationReport {
  return {
    entryPoints: Array.isArray(raw.entryPoints) ? raw.entryPoints : [],
    patterns: typeof raw.patterns === 'string' ? raw.patterns : '',
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    risks: typeof raw.risks === 'string' ? raw.risks : '',
    approach: typeof raw.approach === 'string' ? raw.approach : '',
    keySnippets: raw.keySnippets && typeof raw.keySnippets === 'object' ? raw.keySnippets : {},
  };
}

export async function runArchitectAgent(params: {
  userPrompt: string;
  projectTree: string;
  explorationReport: ExplorationReport;
  writeScope: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  runId?: string;
  taskId?: string;
  projectName?: string;
}): Promise<{ plan: ArchitectPlan; tokensUsed: number }> {
  if (params.signal?.aborted) throw new Error('AbortError');

  params.onProgress?.('📐 Architect designing implementation plan...');

  const response = await roleCompletion('architect', {
    messages: [
      {
        role: 'system',
        content: buildArchitectPrompt({
          userPrompt: params.userPrompt,
          projectTree: params.projectTree,
          explorationReport: params.explorationReport,
          writeScope: params.writeScope,
        }),
      },
      { role: 'user', content: `Design the implementation for: ${params.userPrompt}` },
    ],
    signal: params.signal,
    runId: params.runId,
    taskId: params.taskId,
    projectName: params.projectName,
  });

  const content = response.content?.trim() || '';

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]) as ArchitectPlan;
      return {
        plan: normalizeArchitectPlan(plan),
        tokensUsed: response.usage.totalTokens,
      };
    }
  } catch {
    // Parse failed
  }

  // Fallback plan
  return {
    plan: {
      plan: content || 'Architect could not produce a structured plan. Proceed with direct implementation.',
      fileChanges: [],
      testStrategy: 'Run existing tests after implementation.',
      commitMessage: 'feat: implement requested changes',
    },
    tokensUsed: response.usage.totalTokens,
  };
}

function normalizeArchitectPlan(raw: Partial<ArchitectPlan>): ArchitectPlan {
  return {
    plan: typeof raw.plan === 'string' ? raw.plan : '',
    fileChanges: Array.isArray(raw.fileChanges)
      ? raw.fileChanges.map((fc) => ({
          file: String(fc.file || ''),
          action: fc.action === 'create' ? 'create' : 'modify',
          description: String(fc.description || ''),
          pattern: fc.pattern ? String(fc.pattern) : undefined,
        }))
      : [],
    testStrategy: typeof raw.testStrategy === 'string' ? raw.testStrategy : '',
    commitMessage: typeof raw.commitMessage === 'string' ? raw.commitMessage : 'feat: implement changes',
  };
}

/**
 * Build enriched context from exploration + architecture for the Implementer.
 * This gets injected into the existing code-gen prompt as additional context.
 */
export function buildImplementerContext(
  explorationReport: ExplorationReport,
  architectPlan: ArchitectPlan,
): string {
  const fileChangeSummary = architectPlan.fileChanges
    .map((fc) => `- ${fc.action.toUpperCase()} ${fc.file}: ${fc.description}`)
    .join('\n');

  const snippetSummary = Object.entries(explorationReport.keySnippets)
    .map(([file, snippet]) => `${file}:\n${String(snippet).substring(0, 500)}`)
    .join('\n---\n');

  return `### 🏗️ ARCHITECT'S PLAN
${architectPlan.plan}

### 📋 FILE CHANGES
${fileChangeSummary || 'No specific file changes planned.'}

### 🔍 EXPLORATION CONTEXT
Entry points: ${explorationReport.entryPoints.join(', ')}
Patterns: ${explorationReport.patterns}
Risks: ${explorationReport.risks}

${snippetSummary ? `### 📎 KEY CODE SNIPPETS\n${snippetSummary}` : ''}

### ✅ TEST STRATEGY
${architectPlan.testStrategy}

### 💬 SUGGESTED COMMIT
${architectPlan.commitMessage}`;
}

/**
 * Run the full multi-agent pipeline: Explorer → Architect → (returns context for Implementer).
 *
 * The Implementer step is NOT included here — it's the existing `generateAndWriteCode`
 * function, which receives the enriched context via the `learnedPatterns` injection point.
 */
export async function runAgentPipeline(params: {
  repoPath: string;
  userPrompt: string;
  projectTree: string;
  projectMemory: string | null;
  projectName?: string;
  writeScope: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  runId?: string;
  taskId?: string;
}): Promise<AgentPipelineResult> {
  // Phase 1: Explorer
  const { report, tokensUsed: explorerTokens } = await runExplorerAgent({
    repoPath: params.repoPath,
    userPrompt: params.userPrompt,
    projectTree: params.projectTree,
    projectMemory: params.projectMemory,
    projectName: params.projectName,
    writeScope: params.writeScope,
    signal: params.signal,
    onProgress: params.onProgress,
    runId: params.runId,
    taskId: params.taskId,
  });

  params.onProgress?.(`🔍 Explorer complete: ${report.entryPoints.length} entry points found`);

  // Phase 2: Architect
  const { plan, tokensUsed: architectTokens } = await runArchitectAgent({
    userPrompt: params.userPrompt,
    projectTree: params.projectTree,
    explorationReport: report,
    writeScope: params.writeScope,
    signal: params.signal,
    onProgress: params.onProgress,
    runId: params.runId,
    taskId: params.taskId,
    projectName: params.projectName,
  });

  params.onProgress?.(`📐 Architect complete: ${plan.fileChanges.length} file changes planned`);

  // Build context for the Implementer (injected into the existing code-gen pipeline)
  const implementerContext = buildImplementerContext(report, plan);

  return {
    explorationReport: report,
    architectPlan: plan,
    implementerContext,
    totalTokens: explorerTokens + architectTokens,
  };
}
