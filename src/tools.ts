import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { TARGET_REPO_PATH } from './config.js';

const execPromise = util.promisify(exec);
const REPO_ROOT = path.resolve(TARGET_REPO_PATH);
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.expo', 'ios', 'android', '.next',
]);
const SOURCE_FILE_REGEX = /\.(ts|tsx|js|jsx|json|md)$/i;

function resolveSafePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Invalid path: expected non-empty relative path string.');
  }
  const fullPath = path.resolve(REPO_ROOT, relativePath);
  if (fullPath !== REPO_ROOT && !fullPath.startsWith(`${REPO_ROOT}${path.sep}`)) {
    throw new Error(`Path is outside repo root: ${relativePath}`);
  }
  return fullPath;
}

function lineSlice(content: string, startLine = 1, endLine = 300): string {
  const lines = content.split('\n');
  const safeStart = Math.max(1, Math.floor(startLine));
  const safeEnd = Math.max(safeStart, Math.floor(endLine));
  const clippedEnd = Math.min(lines.length, safeEnd);

  const selected = lines.slice(safeStart - 1, clippedEnd);
  return selected
    .map((line, index) => {
      const lineNumber = String(safeStart + index).padStart(4, ' ');
      return `${lineNumber}| ${line}`;
    })
    .join('\n');
}

export function readFile(filepath: string, startLine = 1, endLine = 300): string {
  try {
    const fullPath = resolveSafePath(filepath);
    if (!fs.existsSync(fullPath)) return `Error: file "${filepath}" does not exist.`;
    if (!fs.statSync(fullPath).isFile()) return `Error: path "${filepath}" is not a file.`;

    const content = fs.readFileSync(fullPath, 'utf8');
    const relative = path.relative(REPO_ROOT, fullPath);
    return `FILE: ${relative}\nLINES: ${startLine}-${endLine}\n\n${lineSlice(content, startLine, endLine)}`;
  } catch (error: any) {
    return `Error reading file "${filepath}": ${error.message}`;
  }
}

interface SearchHit { file: string; lines: Array<{ line: number; text: string }>; }

function collectSearchHits(keyword: string, maxResults: number, dir = REPO_ROOT, hits: SearchHit[] = []): SearchHit[] {
  if (hits.length >= maxResults) return hits;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (hits.length >= maxResults) break;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) collectSearchHits(keyword, maxResults, fullPath, hits);
      continue;
    }

    if (!SOURCE_FILE_REGEX.test(entry.name)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.toLowerCase().includes(keyword.toLowerCase())) continue;

      const matches: Array<{ line: number; text: string }> = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(keyword.toLowerCase())) {
          matches.push({ line: i + 1, text: lines[i].trim() });
          if (matches.length >= 3) break;
        }
      }
      hits.push({ file: path.relative(REPO_ROOT, fullPath), lines: matches });
    } catch { /* Skip unreadable files */ }
  }
  return hits;
}

export function searchProject(keyword: string, maxResults = 30): string {
  try {
    if (typeof keyword !== 'string' || !keyword.trim()) return 'Error: keyword must be a non-empty string.';
    const safeLimit = Math.min(100, Math.max(1, Math.floor(maxResults)));
    const hits = collectSearchHits(keyword.trim(), safeLimit);

    if (!hits.length) return `No matches found for "${keyword}".`;

    const output = hits
      .map((hit) => {
        const snippets = hit.lines.map((l) => `  ${String(l.line).padStart(4, ' ')}| ${l.text}`).join('\n');
        return `- ${hit.file}\n${snippets}`;
      })
      .join('\n');

    return `Keyword "${keyword}" found in ${hits.length} file(s):\n${output}`;
  } catch (error: any) {
    return `Error during search_project: ${error.message}`;
  }
}

export async function runCommand(cmd: string): Promise<string> {
    const trimmedCmd = cmd.trim();

    const blockedPatterns = [/\.\.\//, /(^|\s)\/(?!dev|tmp)/, /~/];
    for (const pattern of blockedPatterns) {
        if (pattern.test(trimmedCmd)) {
            console.log(`🚨 SECURITY BLOCK: Path traversal attempt: ${trimmedCmd}`);
            return `🚨 SECURITY EXCEPTION: Command rejected. You are restricted to the workspace.`;
        }
    }

    const allowedPrefixes = [
        "npm install", "npm uninstall", "npm run", "npm i",
        "npx expo", "npx tsc", "npx eslint", "npx prettier",
        "cd ", "mkdir", "ls", "pwd", "echo",
        "git status", "git diff", "git log"
    ];

    const subCommands = trimmedCmd.split('&&').map(s => s.trim());
    
    for (const subCmd of subCommands) {
        const isAllowed = allowedPrefixes.some(prefix => subCmd.startsWith(prefix));
        if (!isAllowed) {
            console.log(`🚨 SECURITY BLOCK: Unauthorized command attempted: ${subCmd}`);
            return `🚨 SECURITY EXCEPTION: Command rejected. You are ONLY allowed to run safe development commands (npm, npx, cd, ls, mkdir, git status/diff/log).`;
        }
    }

    try {
        console.log(`💻 Executing safe command: ${trimmedCmd}`);
        const { stdout, stderr } = await execPromise(trimmedCmd, { cwd: REPO_ROOT, timeout: 20000 });
        let output = "";
        if (stdout) output += `STDOUT:\n${stdout}\n`;
        if (stderr) output += `STDERR:\n${stderr}\n`;
        return output.trim() ? output.trim() : "Command executed successfully with no output.";
    } catch (error: any) {
        return `⚠️ Command failed:\nSTDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}\nMESSAGE:\n${error.message}`;
    }
}

export const agentTools: any[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a project file before editing it. Use relative paths from repo root. Supports line range for targeted inspection.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Relative path like "kubo-mobile/app/(tabs)/explore.tsx".' },
          startLine: { type: 'number', description: 'Optional first line number (1-based).' },
          endLine: { type: 'number', description: 'Optional last line number (1-based).' },
        },
        required: ['filepath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_project',
      description: 'Search keyword usage across source files and return matching file paths with line snippets.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'String token like "KuboFilterModal" or "JwtAuthGuard".' },
          maxResults: { type: 'number', description: 'Optional cap for matching files (default 30, max 100).' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Executes a bash shell command in the repository root. Use this to install missing npm packages (e.g., "npm install dayjs"), run linters/compilers (e.g., "npx tsc --noEmit"), or check git history (e.g., "git status" or "git diff"). Note: To install in a sub-folder of a monorepo, use cd (e.g., "cd kubo-mobile && npm install lucide-react-native").',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The bash command to execute.' }
        },
        required: ['cmd'],
      },
    },
  }
];