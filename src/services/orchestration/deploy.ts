/**
 * Per-project deploy runner.
 *
 * NOTE (2026-06-16): NOT wired into the UI right now. The panel's old "Deploy"
 * button was reframed to "Run Locally" (the user wanted to SEE the app running,
 * not publish to prod). This module is kept for the future "real deploy" feature
 * (roadmap item: publish FE/BE to a host). Re-wire via a panel button + endpoint
 * when real deploy is built.
 *
 * Reads `.unity/deploy.json` from a project's repo root and runs the configured
 * deploy commands (e.g. FE = Expo EAS, BE = NestJS host). Deploy is an OUTWARD,
 * hard-to-reverse action, so it's only ever triggered explicitly from the panel —
 * never automatically by a run.
 *
 * `.unity/deploy.json` shape:
 * {
 *   "steps": [
 *     { "name": "backend",  "cwd": "infra-red",   "command": "fly deploy" },
 *     { "name": "frontend", "cwd": "kubo-mobile",  "command": "eas update --branch production --auto" }
 *   ]
 * }
 * `cwd` is repo-root-relative (defaults to "."). Steps run in order; the first
 * failure stops the deploy and is reported.
 */
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export interface DeployStepConfig {
  name: string;
  cwd: string;
  command: string;
}

export interface DeployConfig {
  steps: DeployStepConfig[];
}

export interface DeployStepResult {
  name: string;
  command: string;
  status: 'succeeded' | 'failed' | 'skipped';
  output: string;
  durationMs: number;
}

export interface DeployResult {
  status: 'succeeded' | 'failed' | 'no-config';
  steps: DeployStepResult[];
  message: string;
}

const DEPLOY_CONFIG_RELATIVE = path.join('.unity', 'deploy.json');

/** Load `.unity/deploy.json` for a repo, or null if absent/invalid. */
export function loadDeployConfig(repoPath: string): DeployConfig | null {
  const configPath = path.join(repoPath, DEPLOY_CONFIG_RELATIVE);
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) return null;

    const steps: DeployStepConfig[] = raw.steps
      .map((s: any) => ({
        name: typeof s.name === 'string' ? s.name : 'step',
        cwd: typeof s.cwd === 'string' ? s.cwd : '.',
        command: typeof s.command === 'string' ? s.command : '',
      }))
      .filter((s: DeployStepConfig) => s.command.trim().length > 0);

    return steps.length ? { steps } : null;
  } catch {
    return null;
  }
}

/** Does this project have a deploy config? (cheap check for UI gating). */
export function hasDeployConfig(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, DEPLOY_CONFIG_RELATIVE));
}

/**
 * Run the deploy steps in order. Stops at the first failure. Each step gets a
 * generous timeout (deploys can be slow). Output is captured and truncated.
 */
export async function runDeploy(
  repoPath: string,
  onLog?: (message: string) => void,
): Promise<DeployResult> {
  const config = loadDeployConfig(repoPath);
  if (!config) {
    return {
      status: 'no-config',
      steps: [],
      message: `No .unity/deploy.json found in ${repoPath}. Add one with a "steps" array to enable deploy.`,
    };
  }

  const results: DeployStepResult[] = [];
  let failed = false;

  for (const step of config.steps) {
    if (failed) {
      results.push({ name: step.name, command: step.command, status: 'skipped', output: '', durationMs: 0 });
      continue;
    }

    const cwd = path.isAbsolute(step.cwd) ? step.cwd : path.join(repoPath, step.cwd);
    onLog?.(`🚀 [deploy:${step.name}] Running \`${step.command}\` in ${cwd}...`);
    const startedAt = Date.now();

    try {
      const { stdout, stderr } = await execPromise(step.command, {
        cwd,
        timeout: 600_000, // 10 min — deploys can be slow
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1' },
      });
      const output = `${stdout}\n${stderr}`.trim().slice(-4000);
      results.push({
        name: step.name,
        command: step.command,
        status: 'succeeded',
        output,
        durationMs: Date.now() - startedAt,
      });
      onLog?.(`✅ [deploy:${step.name}] Done.`);
    } catch (err: any) {
      failed = true;
      const output = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`.trim().slice(-4000);
      results.push({
        name: step.name,
        command: step.command,
        status: 'failed',
        output,
        durationMs: Date.now() - startedAt,
      });
      onLog?.(`❌ [deploy:${step.name}] Failed (exit ${err?.code ?? '?'}).`);
    }
  }

  return {
    status: failed ? 'failed' : 'succeeded',
    steps: results,
    message: failed
      ? 'Deploy failed. See step output for details.'
      : `Deploy completed: ${results.length} step(s) succeeded.`,
  };
}
