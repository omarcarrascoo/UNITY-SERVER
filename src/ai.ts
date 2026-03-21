import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { TARGET_REPO_PATH } from './config.js';
import { agentTools, readFile, searchProject, runCommand } from './tools.js';

const execPromise = util.promisify(exec);

export interface FileEdit {
  filepath: string;
  search: string;
  replace: string;
}

export interface AIResponse {
  targetRoute: string;
  commitMessage: string;
  edits: FileEdit[];
}

interface ValidationResult {
  rawOutput: string;
  normalizedErrors: Set<string>;
}

// Stable repository heuristics injected into the system prompt for architectural consistency.
const REPO_PATTERNS = `
REPOSITORY OVERVIEW
- Monorepos structure: frontends (expo) and backends (nest/api).
- Single repos: standard expo app.

FRONTEND PATTERNS (Expo)
- Routes live in app/.
- Reuse UI blocks from components/ui.
- Use theme tokens from theme/index.ts.

BACKEND PATTERNS (NestJS)
- Keep domain structure: module + controller + service + schema + dto.

DELIVERY RULES
- Do minimal edits.
- Use "search" and "replace" blocks to patch files. The "search" string MUST perfectly match existing code.
`;

// Assembles static policies with dynamic context (tree, memory, figma, and current diff).
function buildSystemPrompt(
  userPrompt: string,
  figmaData: string | null,
  projectTree: string,
  projectMemory: string | null,
  currentDiff: string | null,
): string {
  const figmaInstructions = figmaData
    ? `FIGMA JSON CONTEXT:\n${figmaData}`
    : 'FIGMA JSON CONTEXT: (none)';

  const memoryInstructions = projectMemory
    ? `\n\n### 🧠 STRICT PROJECT RULES (.unityrc.md) 🧠
You MUST strictly follow these architectural rules for this project:
${projectMemory}\n`
    : '';

  const diffInstructions = currentDiff
    ? `\n\n### 📝 UNCOMMITTED CHANGES (SHORT-TERM MEMORY) 📝
You are in an iteration. You have ALREADY made the following changes in this session. DO NOT undo them unless explicitly asked. Use this as context for what you just built:
\`\`\`diff
${currentDiff.substring(0, 4000)}
\`\`\`\n`
    : '';

  return `
You are Jarvis, a senior autonomous software architect.

PROJECT TREE
${projectTree || '(empty)'}

${REPO_PATTERNS}
${figmaInstructions}${memoryInstructions}${diffInstructions}

USER OBJECTIVE
"${userPrompt}"

COGNITIVE EXECUTION RULES
1) Before using any tool, first determine:
   - the exact user request,
   - the smallest viable implementation that satisfies it,
   - whether the task is frontend-only, backend-only, or full-stack,
   - the minimum set of files likely needed,
   - what you will NOT change unless strictly required.

2) Prefer the smallest correct implementation first.
   - For UI/navigation requests, default to UI entry + route/screen wiring first.
   - Only add backend changes if the request explicitly requires end-to-end behavior or the frontend cannot function without them.

3) Stop exploring once you have enough evidence to implement.
   - Do NOT continue broad searches once the target component, route pattern, and implementation style are clear.
   - Each tool call must have high implementation value.

4) Distinguish between:
   - request completion: the minimal implementation that satisfies the user request,
   - ideal completion: a broader end-to-end solution.
   Always complete request completion first unless explicitly asked for the broader solution.

5) Stay focused on the requested task.
   - Do NOT repair unrelated setup issues unless they are strictly blocking the requested change.
   - If validation reveals pre-existing project errors unrelated to your edits, do not assume your implementation is wrong.

6) After your first useful discoveries, identify mentally:
   - primary target file,
   - supporting file,
   - optional dependency file.
   Then prioritize patching over further exploration.

7) Before producing the final JSON, verify:
   - your edits match the implementation you decided to make,
   - your commit message matches the actual changes,
   - your targetRoute matches the implemented user flow.

TOOL USAGE CONTRACT
1) ONLY inspect files with 'read_file' if modifying them is strictly necessary. Do NOT read files for simple creations (like READMEs).
2) If you use 'read_file', ONLY read the specific lines you need (use startLine and endLine).
3) Use 'search_project' to find unknown components or patterns.
4) Use 'run_command' ONLY to execute safe system/dependency commands (e.g., "cd app-folder && npm install package-name" or "npx tsc").
5) CRITICAL RULE: DO NOT use 'run_command' to create or modify code files (no 'touch', 'echo', or 'cat'). All file creations and modifications MUST be done via the FINAL OUTPUT JSON.
6) Before calling a tool, you MUST write a brief 1-2 sentence explanation of your thought process in the message content.
7) Prefer tool calls that directly unblock implementation over broad exploratory searches.

FINAL OUTPUT CONTRACT (STRICT)
- Return exactly ONE valid JSON object.
- JSON shape:
{
  "targetRoute": "/path",
  "commitMessage": "feat: summary",
  "edits": [
    {
      "filepath": "relative/path.ts",
      "search": "exact code to replace",
      "replace": "new code"
    }
  ]
}
- If creating a NEW file, leave "search" empty.
  `;
}

// Extracts the first valid JSON object from model text that may include markdown wrappers.
function extractJsonObject(raw: string): string {
  const text = (raw || '')
    .trim()
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
    .replace(/[\u00A0\u2028\u2029\u200B]/g, ' ');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  throw new Error('No JSON object found.');
}

// Guards file writes so generated edits cannot escape the active repository root.
function resolveSafeFilePath(relativeFilePath: string): string {
  const repoRoot = path.resolve(TARGET_REPO_PATH);
  const fullPath = path.resolve(repoRoot, relativeFilePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Blocked unsafe path: ${relativeFilePath}`);
  }

  return fullPath;
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;

  let count = 0;
  let searchStartIndex = 0;

  while (true) {
    const foundIndex = content.indexOf(search, searchStartIndex);
    if (foundIndex === -1) break;

    count += 1;
    searchStartIndex = foundIndex + search.length;
  }

  return count;
}

// Applies search/replace patches; "search" empty means create or overwrite file content.
function applyEditsToFiles(edits: FileEdit[]): string[] {
  const patchErrors: string[] = [];

  for (const edit of edits) {
    if (!edit.filepath) continue;

    const fullPath = resolveSafeFilePath(edit.filepath);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(fullPath) || edit.search.trim() === '') {
      fs.writeFileSync(fullPath, edit.replace, 'utf8');
      continue;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    const occurrences = countOccurrences(content, edit.search);

    if (occurrences === 0) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: Exact 'search' block not found. You must match spaces and line breaks perfectly.`,
      );
      continue;
    }

    if (occurrences > 1) {
      patchErrors.push(
        `⚠️ Error in ${edit.filepath}: Ambiguous 'search' block. Found ${occurrences} matches. Provide a more specific block.`,
      );
      continue;
    }

    const updatedContent = content.replace(edit.search, edit.replace);
    fs.writeFileSync(fullPath, updatedContent, 'utf8');
  }

  return patchErrors;
}

function getDirsToCheck(edits: FileEdit[]): string[] {
  if (!edits.length) return ['.'];

  return Array.from(
    new Set(
      edits.map((edit) => {
        const parts = edit.filepath.split('/');
        return parts.length > 1 ? parts[0] : '.';
      }),
    ),
  );
}

function normalizeCompilationOutput(rawOutput: string): Set<string> {
  return new Set(
    rawOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('[Error in '))
      .filter((line) => !line.startsWith('Found '))
      .filter((line) => line !== 'error Command failed with exit code 2.')
      .map((line) => line.replace(/\s+/g, ' ')),
  );
}

async function runTypecheckForDirs(dirs: string[]): Promise<ValidationResult> {
  let rawOutput = '';

  for (const dir of dirs) {
    const checkPath = dir === '.' ? TARGET_REPO_PATH : path.join(TARGET_REPO_PATH, dir);

    if (!fs.existsSync(path.join(checkPath, 'tsconfig.json'))) {
      continue;
    }

    try {
      await execPromise(`npx tsc --noEmit`, { cwd: checkPath });
    } catch (err: any) {
      rawOutput += `\n[Error in ${dir}]:\n${err.stdout || err.message}\n`;
    }
  }

  return {
    rawOutput: rawOutput.trim(),
    normalizedErrors: normalizeCompilationOutput(rawOutput),
  };
}

function getNewCompilationErrors(
  baseline: ValidationResult,
  current: ValidationResult,
): string[] {
  const newErrors: string[] = [];

  for (const line of current.normalizedErrors) {
    if (!baseline.normalizedErrors.has(line)) {
      newErrors.push(line);
    }
  }

  return newErrors;
}

async function getCurrentGitDiff(): Promise<string> {
  try {
    const { stdout } = await execPromise(`git diff`, { cwd: TARGET_REPO_PATH });
    return stdout || '';
  } catch {
    return '';
  }
}

function isFatalToolError(toolResult: string): boolean {
  const fatalMarkers = [
    'SECURITY EXCEPTION',
    'Path is outside repo root',
    'Blocked unsafe path',
    'Unsupported tool',
    'Empty command',
  ];

  return fatalMarkers.some((marker) => toolResult.includes(marker));
}

function isFatalRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  const fatalMarkers = [
    'AbortError',
    'Model returned an empty response.',
  ];

  return fatalMarkers.some((marker) => message.includes(marker));
}

function countBroadExplorationCalls(toolHistory: string[]): number {
  const broadPatterns = [
    /^search_project:menu$/i,
    /^search_project:register$/i,
    /^search_project:origin$/i,
  ];

  return toolHistory.filter((entry) =>
    broadPatterns.some((pattern) => pattern.test(entry)),
  ).length;
}

function hasEnoughTargetEvidence(toolHistory: string[]): boolean {
  const usefulSignals = [
    'read_file:',
    'search_project:KuboHomeHeader',
    'search_project:Header',
    'search_project:register-studio',
    'search_project:register',
  ];

  let score = 0;

  for (const entry of toolHistory) {
    if (usefulSignals.some((signal) => entry.includes(signal))) {
      score += 1;
    }
  }

  return score >= 3;
}

// Main generation loop: tool calls + patching + compile validation + self-correction retries.
export async function generateAndWriteCode(
  userPrompt: string,
  figmaData: string | null,
  projectTree: string,
  projectMemory: string | null,
  currentDiff: string | null,
  onStatusUpdate?: (status: string, thought?: string) => void,
  signal?: AbortSignal,
): Promise<{ targetRoute: string; commitMessage: string; tokenUsage: number }> {
  const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY as string,
  });

  const messages: any[] = [
    {
      role: 'system',
      content: buildSystemPrompt(userPrompt, figmaData, projectTree, projectMemory, currentDiff),
    },
    { role: 'user', content: userPrompt },
  ];

  let finalResult: AIResponse | null = null;
  const MAX_LOOPS = 100;
  let totalTokens = 0;
  const toolHistory: string[] = [];

  for (let loop = 1; loop <= MAX_LOOPS; loop++) {
    if (signal?.aborted) throw new Error('AbortError');

    const statusMsg = `🔄 Iteration ${loop}... Thinking...`;
    console.log(statusMsg);
    if (onStatusUpdate) onStatusUpdate(statusMsg);

    const response = await openai.chat.completions.create(
      {
        model: 'deepseek-chat',
        messages,
        tools: agentTools,
        temperature: 0.1,
        max_tokens: 8192,
      },
      { signal },
    );

    if (response.usage) {
      totalTokens += response.usage.total_tokens;
    }

    const message = response.choices?.[0]?.message;
    if (!message) throw new Error('Model returned an empty response.');

    messages.push(message);

    const agentThought = message.content ? message.content.trim() : '';

    if (message.tool_calls?.length) {
      const broadExplorationCount = countBroadExplorationCalls(toolHistory);
      const enoughEvidence = hasEnoughTargetEvidence(toolHistory);

      if (broadExplorationCount >= 3 && enoughEvidence) {
        messages.push({
          role: 'user',
          content: `You already have enough context to implement the smallest requested change.
Stop broad exploration and produce the patch for the minimal valid implementation.
Do not expand the scope unless a concrete blocker remains.`,
        });

        if (onStatusUpdate) {
          onStatusUpdate('⚠️ Jarvis had enough evidence and was redirected to implementation.');
        }

        continue;
      }

      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        let toolResult = '';

        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const toolDescriptor = `${functionName}:${args.filepath || args.keyword || args.cmd || ''}`;
          toolHistory.push(toolDescriptor);

          const toolMsg = `🛠️ Executing: ${functionName} -> ${args.filepath || args.keyword || args.cmd}`;
          console.log(toolMsg);

          if (onStatusUpdate) onStatusUpdate(toolMsg, agentThought);

          if (functionName === 'read_file') {
            toolResult = readFile(args.filepath, args.startLine, args.endLine);
          } else if (functionName === 'search_project') {
            toolResult = searchProject(args.keyword, args.maxResults);
          } else if (functionName === 'run_command') {
            toolResult = await runCommand(args.cmd);
          } else {
            toolResult = `Tool error: Unsupported tool "${functionName}"`;
          }

          if (isFatalToolError(toolResult)) {
            throw new Error(toolResult);
          }
        } catch (error: any) {
          const errorMessage = error?.message || String(error);

          if (isFatalRuntimeError(error)) {
            throw error;
          }

          toolResult = `Tool error: ${errorMessage}`;
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolResult,
        });
      }

      continue;
    }

    const modelText = message.content || '';

    try {
      const candidate = extractJsonObject(modelText);
      finalResult = JSON.parse(candidate) as AIResponse;

      if (agentThought && onStatusUpdate) {
        onStatusUpdate('🧪 Validating syntax and compilation...', agentThought);
      }

      const dirsToCheck = getDirsToCheck(finalResult.edits || []);
      const baselineValidation = await runTypecheckForDirs(dirsToCheck);

      const patchErrors = applyEditsToFiles(finalResult.edits || []);
      if (patchErrors.length > 0) {
        messages.push({
          role: 'user',
          content: `🚨 PATCH ERROR 🚨
I could not apply your code. The following errors occurred:
${patchErrors.join('\n')}

Please generate a new JSON correcting the 'search' block so it matches the current file exactly.
If the block is ambiguous, make the search more specific so it matches only one location.`,
        });

        if (onStatusUpdate) onStatusUpdate('⚠️ Error injecting code. Jarvis is self-correcting...');
        finalResult = null;
        continue;
      }

      const currentValidation = await runTypecheckForDirs(dirsToCheck);
      const newCompilationErrors = getNewCompilationErrors(baselineValidation, currentValidation);

      if (currentValidation.rawOutput.trim() !== '') {
        if (baselineValidation.rawOutput.trim() === '') {
          messages.push({
            role: 'user',
            content: `🚨 COMPILATION ERROR 🚨
Your last changes introduced TypeScript errors in the validated scope.

Errors:
${currentValidation.rawOutput.substring(0, 1200)}

Repair only issues directly related to the files you edited.
Do NOT expand into unrelated project cleanup.
The files ALREADY have your changes applied. Your new 'search' must target the broken code you just wrote.
Generate a new JSON with the smallest fix.`,
          });

          if (onStatusUpdate) onStatusUpdate('⚠️ Compiler detected new errors. Jarvis is rewriting logic...');
          finalResult = null;
          continue;
        }

        if (newCompilationErrors.length > 0) {
          messages.push({
            role: 'user',
            content: `🚨 COMPILATION ERROR 🚨
The project already had TypeScript errors in this scope, but your last changes appear to have introduced ADDITIONAL errors.

New errors detected:
${newCompilationErrors.slice(0, 20).join('\n').substring(0, 1200)}

Only fix errors directly related to the files you edited.
Do NOT try to repair unrelated setup, ORM generation, environment, or infrastructure issues unless they are strictly required for the user's request.
Generate the smallest corrective JSON patch.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Compiler detected additional errors beyond the baseline. Jarvis is self-correcting...');
          }
          finalResult = null;
          continue;
        }

        if (onStatusUpdate) {
          onStatusUpdate('⚠️ TypeScript still has pre-existing errors in this scope, but no new errors were introduced by the latest edits.');
        }
      }

      if ((finalResult.edits || []).length === 0) {
        const diffAfterValidation = await getCurrentGitDiff();
        const hasUnexpectedDiff = diffAfterValidation.trim() !== '' && !currentDiff?.trim();

        if (hasUnexpectedDiff) {
          messages.push({
            role: 'user',
            content: `🚨 RESULT CONSISTENCY ERROR 🚨
You returned "edits": [] but the repository still has uncommitted changes.

This usually means your final JSON does not accurately describe the current state.
Return a corrected JSON that reflects the actual changes needed from the CURRENT repository state, or explicitly clean up unintended changes first.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Final JSON was inconsistent with repository state. Jarvis is correcting the result...');
          }
          finalResult = null;
          continue;
        }
      }

      if ((finalResult.edits || []).length > 0) {
        const editedTopLevelTargets = new Set(
          finalResult.edits.map((edit) => edit.filepath.split('/')[0]),
        );

        if (
          finalResult.targetRoute &&
          finalResult.targetRoute !== '/' &&
          editedTopLevelTargets.size === 0
        ) {
          messages.push({
            role: 'user',
            content: `🚨 RESULT COHERENCE ERROR 🚨
Your final result includes a targetRoute but the edits do not clearly reflect an implementation for that flow.
Re-check that your JSON accurately matches the code changes you made and return a corrected JSON.`,
          });

          if (onStatusUpdate) {
            onStatusUpdate('⚠️ Final result was weakly aligned with the implementation. Jarvis is correcting coherence...');
          }

          finalResult = null;
          continue;
        }
      }

      if (onStatusUpdate) onStatusUpdate('✅ Code successfully validated by compiler.');
      break;
    } catch (error) {
      if (isFatalRuntimeError(error)) {
        throw error;
      }

      messages.push({
        role: 'user',
        content: 'Response was not valid JSON or failed to parse. Return exactly one JSON object.',
      });
    }
  }

  if (!finalResult) {
    throw new Error('Agent reached loop limit without passing compilation checks.');
  }

  return {
    targetRoute: finalResult.targetRoute || '/',
    commitMessage: finalResult.commitMessage || 'feat: auto-update',
    tokenUsage: totalTokens,
  };
}

// Summarizes the accumulated diff into a conventional commit for PR title/body usage.
export async function generatePRMetadata(diff: string): Promise<string> {
  const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY as string,
  });

  const prompt = `You are an expert developer. I will provide you with a git diff of the work done in this session.
Please generate a conventional commit message that summarizes ALL the changes comprehensively.
Format it as a single string where the first line is the conventional commit title (e.g., feat: added login screen), followed by a blank line, and then a brief bulleted list of the key changes.

GIT DIFF:
${diff.substring(0, 6000)}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });

    return response.choices[0]?.message?.content?.trim() || 'feat: accumulated session updates';
  } catch (error) {
    console.error('Error generating Smart PR:', error);
    return 'feat: accumulated session updates';
  }
}