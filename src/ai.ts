import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { TARGET_REPO_PATH } from './config.js';
import { agentTools, readFile, searchProject, runCommand } from './tools.js'; 

export interface FileEdit { filepath: string; search: string; replace: string; }
export interface AIResponse { targetRoute: string; commitMessage: string; edits: FileEdit[]; }

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

function buildSystemPrompt(userPrompt: string, figmaData: string | null, projectTree: string): string {
  const figmaInstructions = figmaData ? `FIGMA JSON CONTEXT:\n${figmaData}` : 'FIGMA JSON CONTEXT: (none)';

  return `
You are Jarvis, a senior autonomous software architect.

PROJECT TREE
${projectTree || '(empty)'}

${REPO_PATTERNS}
${figmaInstructions}

USER OBJECTIVE
"${userPrompt}"

TOOL USAGE CONTRACT
1) Inspect files with 'read_file' before editing.
2) Use 'search_project' to find unknown components.
3) Use 'run_command' ONLY to execute system/dependency commands (e.g., "cd app-folder && npm install package-name" or "npx tsc"). 
4) CRITICAL RULE: DO NOT use 'run_command' to create or modify code files (no 'touch', 'echo', or 'cat'). All file creations and modifications MUST be done via the FINAL OUTPUT JSON.
5) Before calling a tool, you MUST write a brief 1-2 sentence explanation of your thought process in the message content.

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

function extractJsonObject(raw: string): string {
  let text = (raw || '').trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  text = text.replace(/[\u00A0\u2028\u2029\u200B]/g, ' ');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  throw new Error('No JSON object found.');
}

function resolveSafeFilePath(relativeFilePath: string): string {
  const repoRoot = path.resolve(TARGET_REPO_PATH);
  const fullPath = path.resolve(repoRoot, relativeFilePath);
  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Blocked unsafe path: ${relativeFilePath}`);
  }
  return fullPath;
}

export async function generateAndWriteCode(
  userPrompt: string,
  figmaData: string | null,
  projectTree: string,
  onStatusUpdate?: (status: string, thought?: string) => void
): Promise<{ targetRoute: string; commitMessage: string; tokenUsage: number }> {
  
  const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY as string });

  const messages: any[] = [
    { role: 'system', content: buildSystemPrompt(userPrompt, figmaData, projectTree) },
    { role: 'user', content: userPrompt },
  ];

  let finalResult: AIResponse | null = null;
  const MAX_LOOPS = 100;
  let totalTokens = 0; 

  for (let loop = 1; loop <= MAX_LOOPS; loop++) {
    const statusMsg = `🔄 Iteration ${loop}... Thinking...`;
    console.log(statusMsg);
    if (onStatusUpdate) onStatusUpdate(statusMsg);

    const response = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages,
      tools: agentTools,
      temperature: 0.1,
      max_tokens: 8192,
    });

    if (response.usage) {
      totalTokens += response.usage.total_tokens;
    }

    const message = response.choices?.[0]?.message;
    if (!message) throw new Error('Model returned an empty response.');

    messages.push(message);

    const agentThought = message.content ? message.content.trim() : "";

    if (message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        let toolResult = '';

        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const toolMsg = `🛠️ Executing: ${functionName} -> ${args.filepath || args.keyword || args.cmd}`;
          console.log(toolMsg);
          
          if (onStatusUpdate) onStatusUpdate(toolMsg, agentThought);

          if (functionName === 'read_file') {
            toolResult = readFile(args.filepath, args.startLine, args.endLine);
          } else if (functionName === 'search_project') {
            toolResult = searchProject(args.keyword, args.maxResults);
          } else if (functionName === 'run_command') {
            toolResult = await runCommand(args.cmd);
          }
        } catch (error: any) {
          toolResult = `Tool error: ${error.message}`;
        }

        messages.push({ role: 'tool', tool_call_id: toolCall.id, name: functionName, content: toolResult });
      }
      continue;
    }

    const modelText = message.content || '';
    try {
      const candidate = extractJsonObject(modelText);
      finalResult = JSON.parse(candidate) as AIResponse;
      
      if (agentThought && onStatusUpdate) {
          onStatusUpdate(`✅ Preparing final code delivery...`, agentThought);
      }
      break;
    } catch {
      messages.push({ role: 'user', content: 'Response was not valid JSON or failed to parse. Return exactly one JSON object.' });
    }
  }

  if (!finalResult) throw new Error('Agent reached loop limit without valid JSON.');

  if (onStatusUpdate) onStatusUpdate(`✅ Code ready! Applying surgical edits...`);

  for (const edit of finalResult.edits || []) {
    if (!edit.filepath) continue;
    const fullPath = resolveSafeFilePath(edit.filepath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(fullPath) || edit.search.trim() === "") {
        fs.writeFileSync(fullPath, edit.replace, 'utf8'); 
        continue;
    }

    let content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes(edit.search)) {
        content = content.replace(edit.search, edit.replace);
        fs.writeFileSync(fullPath, content, 'utf8');
    } else {
        console.warn(`⚠️ Warning: Exact search block not found in ${edit.filepath}.`);
    }
  }

  return { targetRoute: finalResult.targetRoute || '/', commitMessage: finalResult.commitMessage || 'feat: auto-update', tokenUsage: totalTokens };
}