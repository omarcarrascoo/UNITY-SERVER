import fs from 'fs';
import path from 'path';
import { ChildProcess, exec, spawn } from 'child_process';
import util from 'util';
import type { PreparedWorkspace } from '../../domain/runtime.js';
import {
  resolveRuntimeManifest,
  getLocalIpAddress,
  type RuntimeServiceConfig,
} from './runtime-gate-config.js';

const execPromise = util.promisify(exec);

const activeProcesses: ChildProcess[] = [];

export interface RuntimeGateResult {
  localUrl: string | null;
  publicUrl: string | null;
  details: string;
  status: 'passed' | 'failed';
}

type RuntimeLogFn = (message: string) => Promise<void> | void;

async function emitRuntimeLog(onLog: RuntimeLogFn | undefined, message: string): Promise<void> {
  if (onLog) await onLog(message);
}

function killTrackedProcess(proc: ChildProcess | null): void {
  if (!proc?.pid) return;
  try {
    proc.kill('SIGKILL');
  } catch {
    // Ignore cleanup errors.
  }
}

async function killPort(port: number): Promise<void> {
  await execPromise(`fuser -k ${port}/tcp || true`).catch(() => {});
}

function cleanupActiveProcesses(): void {
  for (const proc of activeProcesses) {
    killTrackedProcess(proc);
  }
  activeProcesses.length = 0;
}

function hasNodeModules(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'node_modules')).isDirectory();
  } catch {
    return false;
  }
}

function getPackageManagerHint(dir: string): string {
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  return 'npm';
}

function getInstallCommand(dir: string): string {
  const hint = getPackageManagerHint(dir);
  if (hint === 'yarn') return 'yarn install';
  if (hint === 'pnpm') return 'pnpm install';
  return 'npm install';
}

async function ensureNodeModules(
  service: RuntimeServiceConfig,
  onLog?: RuntimeLogFn,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!service.requiresNodeModules) return { ok: true };
  if (hasNodeModules(service.cwd)) return { ok: true };

  if (!fs.existsSync(path.join(service.cwd, 'package.json'))) {
    return {
      ok: false,
      error: `${service.name} prerequisites missing: no package.json found in ${service.cwd}.`,
    };
  }

  const installCmd = getInstallCommand(service.cwd);
  await emitRuntimeLog(
    onLog,
    `📦 [runtime:${service.name}] node_modules missing in ${service.cwd} — running \`${installCmd}\` (may take a while).`,
  );

  try {
    await execPromise(installCmd, {
      cwd: service.cwd,
      timeout: 300_000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `${service.name} prerequisites missing: auto-install failed in ${service.cwd}. ${message}`,
    };
  }

  if (!hasNodeModules(service.cwd)) {
    return {
      ok: false,
      error: `${service.name} prerequisites missing: auto-install completed but node_modules still absent in ${service.cwd}.`,
    };
  }

  await emitRuntimeLog(onLog, `✅ [runtime:${service.name}] node_modules restored via auto-install.`);
  return { ok: true };
}

function injectEnvVar(dir: string, key: string, value: string): void {
  const envPath = path.join(dir, '.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  }
  const pattern = new RegExp(`^${key}=.*$`, 'gm');
  content = content.replace(pattern, '').trim();
  content += `\n${key}=${value}\n`;
  fs.writeFileSync(envPath, content.trim() + '\n');
}

/**
 * Start a single service and wait for its readySignal.
 * Returns the spawned process or null on failure.
 */
async function startService(
  service: RuntimeServiceConfig,
  onLog?: RuntimeLogFn,
): Promise<{ proc: ChildProcess; log: string } | { error: string }> {
  // Pre-flight: ensure node_modules (auto-install if missing)
  const nodeModulesCheck = await ensureNodeModules(service, onLog);
  if (!nodeModulesCheck.ok) {
    await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${nodeModulesCheck.error}`);
    return { error: nodeModulesCheck.error };
  }

  // Kill existing port occupants
  await killPort(service.port);

  const [cmd, ...args] = service.startCommand.split(' ');
  await emitRuntimeLog(onLog, `🌐 [runtime:${service.name}] Starting \`${service.startCommand}\` in ${service.cwd}`);

  const env = { ...process.env, ...service.env };
  const proc = spawn(cmd, args, { cwd: service.cwd, stdio: 'pipe', env });
  activeProcesses.push(proc);

  let serviceLog = '';
  const onOutput = (data: Buffer | string) => {
    serviceLog += data.toString();
  };
  proc.stdout?.on('data', onOutput);
  proc.stderr?.on('data', onOutput);

  // Wait for ready signal or timeout
  const ready = await new Promise<boolean>((resolve) => {
    let resolved = false;

    const checkReady = () => {
      if (resolved) return;
      if (serviceLog.includes(service.readySignal)) {
        resolved = true;
        resolve(true);
      }
    };

    proc.stdout?.on('data', checkReady);
    proc.stderr?.on('data', checkReady);

    proc.on('exit', () => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(false);
      }
    }, service.timeoutMs);

    // Also check what we've already accumulated
    checkReady();
  });

  if (!ready) {
    const exitCode = proc.exitCode;
    const trimmedLog = serviceLog.trim().slice(0, 1000);

    if (exitCode !== null) {
      const details = `${service.name} exited before ready. Exit code: ${exitCode}. Logs: ${trimmedLog}`;
      await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${details}`);
      return { error: details };
    }

    const details = `${service.name} failed to emit ready signal within ${service.timeoutMs}ms.${trimmedLog ? ` Logs: ${trimmedLog}` : ''}`;
    await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${details}`);
    return { error: details };
  }

  await emitRuntimeLog(onLog, `✅ [runtime:${service.name}] Ready on port ${service.port}.`);
  return { proc, log: serviceLog };
}

/**
 * Run the config-driven runtime gate.
 *
 * Starts all services defined in the manifest (backends first, frontends second),
 * links backend URL to frontend if configured, and reports overall health.
 */
export async function runProjectRuntimeGate(
  workspace: PreparedWorkspace,
  targetRoute = '/',
  onLog?: RuntimeLogFn,
): Promise<RuntimeGateResult> {
  // Cleanup any previous runtime processes
  cleanupActiveProcesses();

  const manifest = resolveRuntimeManifest(workspace.repoPath, workspace.expoPath, workspace.apiPath);

  if (manifest.services.length === 0) {
    await emitRuntimeLog(onLog, `🌐 [runtime] No runtime services detected. Skipping.`);
    return {
      localUrl: null,
      publicUrl: null,
      details: 'No runtime-capable app detected. Skipping runtime gate.',
      status: 'passed',
    };
  }

  const ip = getLocalIpAddress();

  // Sort: backends first, then frontends, then generic
  const sorted = [...manifest.services].sort((a, b) => {
    const order = { backend: 0, generic: 1, frontend: 2 };
    return (order[a.type] ?? 1) - (order[b.type] ?? 1);
  });

  await emitRuntimeLog(
    onLog,
    `🌐 [runtime] Preflight: ${sorted.length} service(s) to start: ${sorted.map((s) => `${s.name}(${s.type}:${s.port})`).join(', ')}`,
  );

  // Clear all ports
  for (const service of sorted) {
    await killPort(service.port);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  let backendUrl: string | null = null;

  for (const service of sorted) {
    // If linking is enabled and this is a frontend, inject backend URL
    if (
      manifest.linkBackendToFrontend &&
      service.type === 'frontend' &&
      backendUrl
    ) {
      injectEnvVar(service.cwd, manifest.backendUrlEnvVar, backendUrl);
      await emitRuntimeLog(onLog, `🌐 [runtime] Injected ${manifest.backendUrlEnvVar}=${backendUrl} into ${service.cwd}/.env`);
    }

    const result = await startService(service, onLog);

    if ('error' in result) {
      return {
        localUrl: null,
        publicUrl: null,
        details: result.error,
        status: 'failed',
      };
    }

    // Track backend URL for frontend injection
    if (service.type === 'backend') {
      backendUrl = ip ? `http://${ip}:${service.port}` : `http://localhost:${service.port}`;
    }
  }

  // Find the "primary" service for URL reporting (prefer frontend, fallback to first)
  const primary =
    sorted.find((s) => s.type === 'frontend') ||
    sorted[0];

  const route = targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`;
  const localUrl = `http://localhost:${primary.port}${route}`;
  const publicUrl = ip ? `http://${ip}:${primary.port}${route}` : null;

  await emitRuntimeLog(onLog, `✅ [runtime] All ${sorted.length} service(s) healthy. Primary: ${localUrl}`);

  return {
    localUrl,
    publicUrl,
    details: `Runtime available at ${localUrl}. Services: ${sorted.map((s) => s.name).join(', ')}.`,
    status: 'passed',
  };
}
