import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.expo',
  'ios',
  'android',
  '.next',
]);

const SOURCE_FILE_REGEX = /\.(ts|tsx|js|jsx|json|md)$/i;
const SAFE_NPM_RUN_SCRIPTS = new Set(['lint', 'test', 'typecheck', 'build', 'start']);

export interface AgentToolRuntime {
  tools: typeof agentTools;
  readFile: (filepath: string, startLine?: number, endLine?: number) => string;
  searchProject: (keyword: string, maxResults?: number) => string;
  runCommand: (cmd: string) => Promise<string>;
}

function resolveRepoRoot(repoPath: string): string {
  return path.resolve(repoPath);
}

function resolveSafePath(repoRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Invalid path: expected non-empty relative path string.');
  }

  const fullPath = path.resolve(repoRoot, relativePath);

  if (fullPath !== repoRoot && !fullPath.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Path is outside repo root: ${relativePath}`);
  }

  return fullPath;
}

function lineSlice(content: string, startLine = 1, endLine = 300): string {
  const lines = content.split('\n');
  const safeStart = Math.max(1, Math.floor(startLine));
  const safeEnd = Math.max(safeStart, Math.floor(endLine));
  const clippedEnd = Math.min(lines.length, safeEnd);

  return lines
    .slice(safeStart - 1, clippedEnd)
    .map((line, index) => {
      const lineNumber = String(safeStart + index).padStart(4, ' ');
      return `${lineNumber}| ${line}`;
    })
    .join('\n');
}

function createReadFile(repoRoot: string) {
  return (filepath: string, startLine = 1, endLine = 300): string => {
    try {
      const fullPath = resolveSafePath(repoRoot, filepath);

      if (!fs.existsSync(fullPath)) return `Error: file "${filepath}" does not exist.`;
      if (!fs.statSync(fullPath).isFile()) return `Error: path "${filepath}" is not a file.`;

      const content = fs.readFileSync(fullPath, 'utf8');
      const relative = path.relative(repoRoot, fullPath);

      return `FILE: ${relative}\nLINES: ${startLine}-${endLine}\n\n${lineSlice(content, startLine, endLine)}`;
    } catch (error: any) {
      return `Error reading file "${filepath}": ${error.message}`;
    }
  };
}

interface SearchHit {
  file: string;
  lines: Array<{ line: number; text: string }>;
}

function collectSearchHits(
  repoRoot: string,
  keyword: string,
  maxResults: number,
  dir = repoRoot,
  hits: SearchHit[] = [],
): SearchHit[] {
  if (hits.length >= maxResults) return hits;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (hits.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        collectSearchHits(repoRoot, keyword, maxResults, fullPath, hits);
      }
      continue;
    }

    if (!SOURCE_FILE_REGEX.test(entry.name)) continue;

    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (!content.toLowerCase().includes(keyword.toLowerCase())) continue;

      const matches: Array<{ line: number; text: string }> = [];
      const lines = content.split('\n');

      for (let index = 0; index < lines.length; index++) {
        if (lines[index].toLowerCase().includes(keyword.toLowerCase())) {
          matches.push({ line: index + 1, text: lines[index].trim() });
          if (matches.length >= 3) break;
        }
      }

      hits.push({
        file: path.relative(repoRoot, fullPath),
        lines: matches,
      });
    } catch {
      // Ignore files that cannot be read due to permissions or encoding issues.
    }
  }

  return hits;
}

function createSearchProject(repoRoot: string) {
  return (keyword: string, maxResults = 30): string => {
    try {
      if (typeof keyword !== 'string' || !keyword.trim()) {
        return 'Error: keyword must be a non-empty string.';
      }

      const safeLimit = Math.min(100, Math.max(1, Math.floor(maxResults)));
      const hits = collectSearchHits(repoRoot, keyword.trim(), safeLimit);

      if (!hits.length) return `No matches found for "${keyword}".`;

      const output = hits
        .map((hit) => {
          const snippets = hit.lines
            .map((line) => `  ${String(line.line).padStart(4, ' ')}| ${line.text}`)
            .join('\n');
          return `- ${hit.file}\n${snippets}`;
        })
        .join('\n');

      return `Keyword "${keyword}" found in ${hits.length} file(s):\n${output}`;
    } catch (error: any) {
      return `Error during search_project: ${error.message}`;
    }
  };
}

function isSafeCdCommand(command: string): boolean {
  const match = command.match(/^cd\s+(.+)$/);
  if (!match) return false;

  const target = match[1].trim();

  if (!target || target.includes('..') || target.includes('~')) {
    return false;
  }

  return !path.isAbsolute(target);
}

function isSafeNpmRunCommand(command: string): boolean {
  const match = command.match(/^npm\s+run\s+([a-zA-Z0-9:_-]+)(?:\s+--.*)?$/);
  if (!match) return false;

  return SAFE_NPM_RUN_SCRIPTS.has(match[1]);
}

function isAllowedSubCommand(command: string): boolean {
  if (!command) return false;

  if (command.startsWith('npm install')) return true;
  if (command.startsWith('npm uninstall')) return true;
  if (command === 'npm i' || command.startsWith('npm i ')) return true;
  if (command.startsWith('npx expo')) return true;
  if (command.startsWith('npx tsc')) return true;
  if (command.startsWith('npx eslint')) return true;
  if (command.startsWith('npx prettier')) return true;
  if (command === 'ls' || command.startsWith('ls ')) return true;
  if (command === 'pwd') return true;
  if (command === 'git status' || command.startsWith('git status ')) return true;
  if (command === 'git diff' || command.startsWith('git diff ')) return true;
  if (command === 'git log' || command.startsWith('git log ')) return true;

  if (isSafeCdCommand(command)) return true;
  if (isSafeNpmRunCommand(command)) return true;

  return false;
}

function createRunCommand(repoRoot: string) {
  return async (cmd: string): Promise<string> => {
    const trimmedCmd = cmd.trim();

    if (!trimmedCmd) {
      return '🚨 SECURITY EXCEPTION: Command rejected. Empty command.';
    }

    const blockedPatterns = [
      /\.\.\//,
      /(^|\s)\/(?!dev|tmp)/,
      /~/,
      /;/,
      /\|\|/,
      /(^|[^|])\|([^|]|$)/,
      />/,
      /</,
      /(^|[^&])&([^&]|$)/,
    ];

    for (const pattern of blockedPatterns) {
      if (pattern.test(trimmedCmd)) {
        console.log(`🚨 SECURITY BLOCK: Unsafe shell pattern in command: ${trimmedCmd}`);
        return '🚨 SECURITY EXCEPTION: Command rejected. Unsafe shell operators are not allowed.';
      }
    }

    const subCommands = trimmedCmd
      .split('&&')
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (subCommands.length === 0) {
      return '🚨 SECURITY EXCEPTION: Command rejected. No valid subcommands found.';
    }

    for (const subCommand of subCommands) {
      if (!isAllowedSubCommand(subCommand)) {
        console.log(`🚨 SECURITY BLOCK: Unauthorized command attempted: ${subCommand}`);
        return '🚨 SECURITY EXCEPTION: Command rejected. Only safe development commands are allowed.';
      }
    }

    try {
      console.log(`💻 Executing safe command in ${repoRoot}: ${trimmedCmd}`);
      const { stdout, stderr } = await execPromise(trimmedCmd, {
        cwd: repoRoot,
        timeout: 20000,
      });

      let output = '';
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}\n`;

      return output.trim() ? output.trim() : 'Command executed successfully with no output.';
    } catch (error: any) {
      return `⚠️ Command failed:\nSTDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}\nMESSAGE:\n${error.message}`;
    }
  };
}

export function createAgentToolRuntime(repoPath: string): AgentToolRuntime {
  const repoRoot = resolveRepoRoot(repoPath);

  return {
    tools: agentTools,
    readFile: createReadFile(repoRoot),
    searchProject: createSearchProject(repoRoot),
    runCommand: createRunCommand(repoRoot),
  };
}

export const agentTools = [
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
      description: 'Executes a bash shell command in the repository root. Use this to install missing npm packages, run safe scripts like lint/test/typecheck/build/start, run compilers, or inspect git history. To install in a sub-folder of a monorepo, use cd first.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'The bash command to execute.' },
        },
        required: ['cmd'],
      },
    },
  },
] as const;
