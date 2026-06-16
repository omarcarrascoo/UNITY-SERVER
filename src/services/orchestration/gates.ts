import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import type { GateResult } from '../../domain/orchestration.js';
import type { AutonomousRunPolicy } from '../../domain/policies.js';
import type { PreparedWorkspace } from '../../domain/runtime.js';
import { runProjectRuntimeGate, type RuntimeFailure } from './runtime-gate.js';
import { buildImportGraph as buildImportGraphShared, type ImportGraph } from '../../shared/import-graph.js';

const execPromise = util.promisify(exec);

/* ── Secret/Credential Patterns ── */

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi, label: 'API key literal' },
  { pattern: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi, label: 'Secret/password literal' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g, label: 'Private key' },
  { pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, label: 'GitHub token' },
  { pattern: /sk-[A-Za-z0-9]{32,}/g, label: 'OpenAI/Stripe secret key' },
  { pattern: /AKIA[0-9A-Z]{16}/g, label: 'AWS access key ID' },
  { pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, label: 'JWT token' },
];

const SECRET_ALLOWLIST = [
  /\.env\.example$/,
  /\.env\.sample$/,
  /\.test\./,
  /\.spec\./,
  /mock/i,
  /fixture/i,
];

/* ── Import Cycle Detection ── */

function findCycles(graph: ImportGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      // Found a cycle
      const cycleStart = stack.indexOf(node);
      if (cycleStart !== -1) {
        cycles.push([...stack.slice(cycleStart), node]);
      }
      return;
    }

    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    stack.push(node);

    const deps = graph.get(node);
    if (deps) {
      for (const dep of deps) {
        if (graph.has(dep)) {
          dfs(dep);
        }
      }
    }

    stack.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node);
  }

  return cycles;
}

interface PackageScripts {
  dir: string;
  scripts: Record<string, string>;
}

function normalizeScopes(scopes?: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return ['.'];
  }

  const cleaned = scopes.map((scope) => scope.trim()).filter(Boolean);
  return cleaned.length ? cleaned : ['.'];
}

function packageDirMatchesScopes(repoPath: string, packageDir: string, scopes: string[]): boolean {
  const relativeDir = path.relative(repoPath, packageDir) || '.';
  const normalizedScopes = normalizeScopes(scopes);

  if (normalizedScopes.includes('.')) {
    return true;
  }

  return normalizedScopes.some((scope) => {
    return (
      scope === relativeDir ||
      scope.startsWith(`${relativeDir}/`) ||
      relativeDir.startsWith(`${scope}/`)
    );
  });
}

function loadPackageScripts(packageDir: string): PackageScripts | null {
  const packageJsonPath = path.join(packageDir, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return {
    dir: packageDir,
    scripts: raw.scripts || {},
  };
}

function isPlaceholderTestScript(script: string | undefined): boolean {
  return Boolean(script && script.includes('no test specified'));
}

/** Per-gate timeout defaults (ms). Override via env if needed. */
const GATE_TIMEOUTS: Record<string, number> = {
  typecheck: 90_000,
  tsc: 90_000,
  lint: 60_000,
  test: 180_000,
  build: 120_000,
};

function getGateTimeout(gateName: string): number {
  // Extract base gate name (e.g. "typecheck" from "typecheck:apps/web")
  const base = gateName.split(':')[0];
  return GATE_TIMEOUTS[base] ?? 120_000;
}

async function runGateCommand(name: string, cwd: string, command: string): Promise<GateResult> {
  const timeout = getGateTimeout(name);
  try {
    const { stdout, stderr } = await execPromise(command, {
      cwd,
      timeout,
    });

    return {
      name,
      status: 'passed',
      details: [stdout, stderr].filter(Boolean).join('\n').trim() || 'Passed',
    };
  } catch (error: any) {
    const isTimeout = error.killed || error.signal === 'SIGTERM';
    const prefix = isTimeout ? `Gate timed out after ${timeout}ms. ` : '';
    return {
      name,
      status: 'failed',
      details: `${prefix}${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`.trim(),
    };
  }
}

/* ── Security Scan Gate ── */

function scanFileForSecrets(filePath: string, repoPath: string): Array<{ file: string; line: number; label: string }> {
  const relPath = path.relative(repoPath, filePath);

  // Skip allowlisted files
  if (SECRET_ALLOWLIST.some((pattern) => pattern.test(relPath))) {
    return [];
  }

  const findings: Array<{ file: string; line: number; label: string }> = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      for (const { pattern, label } of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i])) {
          findings.push({ file: relPath, line: i + 1, label });
        }
      }
    }
  } catch {
    // Unreadable file
  }

  return findings;
}

function runSecurityScanGate(repoPath: string, scopes: string[]): GateResult {
  const normalizedScopes = normalizeScopes(scopes);
  const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml', '.env'];
  const allFindings: Array<{ file: string; line: number; label: string }> = [];

  function walkDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (sourceExtensions.some((ext) => entry.name.endsWith(ext))) {
          allFindings.push(...scanFileForSecrets(fullPath, repoPath));
        }
      }
    } catch {
      // Permission errors
    }
  }

  const scopeDirs = normalizedScopes.includes('.')
    ? [repoPath]
    : normalizedScopes.map((s) => path.join(repoPath, s));

  for (const dir of scopeDirs) {
    walkDir(dir);
  }

  if (allFindings.length === 0) {
    return {
      name: 'security-scan',
      status: 'passed',
      details: 'No secrets or credentials detected in scope.',
    };
  }

  const summary = allFindings
    .slice(0, 10)
    .map((f) => `  ${f.file}:${f.line} — ${f.label}`)
    .join('\n');
  const extra = allFindings.length > 10 ? `\n  ... and ${allFindings.length - 10} more` : '';

  return {
    name: 'security-scan',
    status: 'failed',
    details: `Found ${allFindings.length} potential secret(s):\n${summary}${extra}`,
  };
}

/* ── Import Cycle Gate ── */

function runImportCycleGate(repoPath: string, scopes: string[]): GateResult {
  const graph = buildImportGraphShared(repoPath, normalizeScopes(scopes));
  const cycles = findCycles(graph);

  if (cycles.length === 0) {
    return {
      name: 'import-cycles',
      status: 'passed',
      details: `No circular imports detected (scanned ${graph.size} files).`,
    };
  }

  const summary = cycles
    .slice(0, 5)
    .map((cycle) => `  ${cycle.join(' → ')}`)
    .join('\n');
  const extra = cycles.length > 5 ? `\n  ... and ${cycles.length - 5} more cycle(s)` : '';

  return {
    name: 'import-cycles',
    status: 'failed',
    details: `Found ${cycles.length} circular import(s):\n${summary}${extra}`,
  };
}

/* ── Static Gates (main entry point — parallel execution) ── */

/**
 * Build the list of gate tasks for a single package directory.
 * Returns an array of { name, promise | result } entries.
 */
function buildPackageGateTasks(
  packageDir: string,
  relativeDir: string,
  gates: AutonomousRunPolicy['gates'],
): Array<Promise<GateResult> | GateResult> {
  const tasks: Array<Promise<GateResult> | GateResult> = [];
  const packageScripts = loadPackageScripts(packageDir);

  if (gates.runTypecheck) {
    if (packageScripts?.scripts.typecheck) {
      tasks.push(runGateCommand(`typecheck:${relativeDir}`, packageDir, 'npm run typecheck'));
    } else if (fs.existsSync(path.join(packageDir, 'tsconfig.json'))) {
      tasks.push(runGateCommand(`tsc:${relativeDir}`, packageDir, 'npx tsc --noEmit'));
    } else {
      tasks.push({ name: `typecheck:${relativeDir}`, status: 'skipped', details: 'No typecheck script or tsconfig found.' });
    }
  }

  if (gates.runLint) {
    if (packageScripts?.scripts.lint) {
      tasks.push(runGateCommand(`lint:${relativeDir}`, packageDir, 'npm run lint'));
    } else {
      tasks.push({ name: `lint:${relativeDir}`, status: 'skipped', details: 'No lint script found.' });
    }
  }

  if (gates.runTests) {
    if (packageScripts?.scripts.test && !isPlaceholderTestScript(packageScripts.scripts.test)) {
      tasks.push(runGateCommand(`test:${relativeDir}`, packageDir, 'npm run test'));
    } else {
      tasks.push({ name: `test:${relativeDir}`, status: 'skipped', details: 'No real test script found.' });
    }
  }

  if (gates.runBuild) {
    if (packageScripts?.scripts.build) {
      tasks.push(runGateCommand(`build:${relativeDir}`, packageDir, 'npm run build'));
    } else {
      tasks.push({ name: `build:${relativeDir}`, status: 'skipped', details: 'No build script found.' });
    }
  }

  return tasks;
}

export async function runStaticGates(
  workspace: PreparedWorkspace,
  policy: AutonomousRunPolicy,
  scopes?: string[],
): Promise<GateResult[]> {
  const gates = policy.gates;
  const packageDirs = Array.from(
    new Set(workspace.packageDirs.length ? workspace.packageDirs : [workspace.repoPath]),
  ).filter((packageDir) => packageDirMatchesScopes(workspace.repoPath, packageDir, scopes || ['.']));

  // Collect all gate tasks across all packages
  const allTasks: Array<Promise<GateResult> | GateResult> = [];

  for (const packageDir of packageDirs) {
    const relativeDir = path.relative(workspace.repoPath, packageDir) || '.';
    allTasks.push(...buildPackageGateTasks(packageDir, relativeDir, gates));
  }

  // Synchronous gates (no subprocess needed)
  if (gates.runSecurityScan) {
    allTasks.push(runSecurityScanGate(workspace.repoPath, scopes || ['.']));
  }
  if (gates.runImportCycleCheck) {
    allTasks.push(runImportCycleGate(workspace.repoPath, scopes || ['.']));
  }

  // Run all gates concurrently — each has its own per-gate timeout
  const results = await Promise.all(
    allTasks.map((task) => (task instanceof Promise ? task : Promise.resolve(task))),
  );

  return results;
}

export interface RuntimeGateDetailed {
  results: GateResult[];
  /** Structured, classified boot failures for auto-healing (empty when passed/skipped). */
  failures: RuntimeFailure[];
}

/**
 * Run the runtime gate and return BOTH the GateResult[] (for summaries/closure)
 * AND the structured failures (for auto-healing). Prefer this in the orchestrator.
 */
export async function runRuntimeGateDetailed(
  workspace: PreparedWorkspace,
  policy: AutonomousRunPolicy,
  targetRoute = '/',
  onLog?: (message: string) => Promise<void> | void,
): Promise<RuntimeGateDetailed> {
  if (!policy.gates.runRuntime) {
    return {
      results: [{ name: 'runtime', status: 'skipped', details: 'Runtime gate disabled by policy.' }],
      failures: [],
    };
  }

  const runtimeResult = await runProjectRuntimeGate(workspace, targetRoute, onLog);

  return {
    results: [
      {
        name: 'runtime',
        status: runtimeResult.status,
        details: runtimeResult.details,
      },
      {
        name: 'runtime:url',
        status: runtimeResult.status === 'passed' ? 'passed' : 'skipped',
        details: runtimeResult.localUrl
          ? `Local: ${runtimeResult.localUrl}${runtimeResult.publicUrl ? ` | Public: ${runtimeResult.publicUrl}` : ''}`
          : 'No runtime URLs available.',
      },
    ],
    failures: runtimeResult.failures,
  };
}

/** Back-compat wrapper returning only GateResult[]. */
export async function runRuntimeGate(
  workspace: PreparedWorkspace,
  policy: AutonomousRunPolicy,
  targetRoute = '/',
  onLog?: (message: string) => Promise<void> | void,
): Promise<GateResult[]> {
  const { results } = await runRuntimeGateDetailed(workspace, policy, targetRoute, onLog);
  return results;
}

export function summarizeGateResults(results: GateResult[]): string {
  return results.map((result) => `${result.name} [${result.status}] ${result.details}`).join('\n');
}
