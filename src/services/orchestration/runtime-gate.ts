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

/** Classification of a runtime boot failure, so healing can target it. */
export type RuntimeFailureKind =
  | 'unresolved-module'
  | 'compile-error'
  | 'missing-env'
  | 'port-in-use'
  | 'prereq-missing'
  | 'timeout'
  | 'unknown';

export interface RuntimeFailure {
  /** Which service failed (e.g. 'expo-web', 'nestjs-api'). */
  service: string;
  kind: RuntimeFailureKind;
  /** One-line human summary. */
  detail: string;
  /** Module that couldn't be resolved (when kind === 'unresolved-module'). */
  module?: string;
  /** File the error points at, repo-root-relative when resolvable. */
  file?: string;
  /** Trimmed raw log for context. */
  rawLog: string;
}

export interface RuntimeGateResult {
  localUrl: string | null;
  publicUrl: string | null;
  details: string;
  status: 'passed' | 'failed';
  /** Structured failures (empty when passed). Drives auto-healing. */
  failures: RuntimeFailure[];
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
  // fuser (Linux) and lsof (macOS) — try both, ignore failures.
  await execPromise(`fuser -k ${port}/tcp || true`).catch(() => {});
  await execPromise(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null || true`).catch(() => {});
}

function cleanupActiveProcesses(): void {
  for (const proc of activeProcesses) {
    killTrackedProcess(proc);
  }
  activeProcesses.length = 0;
}

/** node_modules must exist AND be non-empty (a broken/empty symlink is not "installed"). */
function hasNodeModules(dir: string): boolean {
  const nodeModulesPath = path.join(dir, 'node_modules');
  try {
    const resolved = fs.realpathSync(nodeModulesPath);
    if (!fs.statSync(resolved).isDirectory()) return false;
    // Non-empty check: at least one entry that isn't a dotfile like .package-lock.json.
    const entries = fs.readdirSync(resolved);
    return entries.some((e) => !e.startsWith('.'));
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
    `📦 [runtime:${service.name}] node_modules missing/empty in ${service.cwd} — running \`${installCmd}\` (may take a while).`,
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

/** Strip ANSI color codes so regex classification works on raw logs. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

/**
 * Classify a boot/bundle log into a structured failure. Order matters: the most
 * specific, actionable patterns first.
 */
export function classifyFailure(serviceName: string, rawLogInput: string, kindHint?: RuntimeFailureKind): RuntimeFailure {
  // Strip ANSI, and un-escape JSON-escaped quotes: Metro returns bundle errors as
  // a JSON body (e.g. `\"@x/y\"`) over HTTP but as plain quotes in the terminal.
  const rawLog = stripAnsi(rawLogInput).replace(/\\"/g, '"').trim();
  const trimmed = rawLog.slice(0, 1500);

  // Unable to resolve "X" from "Y"  /  Unable to resolve module X from Y
  // After un-escaping, both quoted forms have real quotes; "from" target may be
  // quoted (terminal/JSON) or bare. Capture the quoted file fully (incl. extension).
  const unresolved =
    rawLog.match(/Unable to resolve (?:module )?["']([^"']+)["'] from ["']([^"'\n]+)["']/i) ||
    rawLog.match(/Unable to resolve (?:module )?["']([^"']+)["'] from ([^\s"'\n]+)/i) ||
    rawLog.match(/Cannot find module ['"]([^'"]+)['"]/i);
  if (unresolved) {
    const moduleName = unresolved[1];
    const fromFile = unresolved[2]?.trim();
    return {
      service: serviceName,
      kind: 'unresolved-module',
      detail: `Unable to resolve "${moduleName}"${fromFile ? ` from ${fromFile}` : ''}.`,
      module: moduleName,
      file: normalizeRepoFile(fromFile),
      rawLog: trimmed,
    };
  }

  // TypeScript compile error: path(line,col): error TSxxxx
  const tsError = rawLog.match(/([^\s(]+\.tsx?)[:(](\d+)[,:](\d+)\)?\s*[-:]?\s*error TS\d+/i);
  if (tsError) {
    return {
      service: serviceName,
      kind: 'compile-error',
      detail: `TypeScript error in ${tsError[1]}:${tsError[2]} — ${firstErrorLine(rawLog)}`,
      file: normalizeRepoFile(tsError[1]),
      rawLog: trimmed,
    };
  }

  // Port already in use
  if (/EADDRINUSE|address already in use/i.test(rawLog)) {
    return { service: serviceName, kind: 'port-in-use', detail: `Port already in use for ${serviceName}.`, rawLog: trimmed };
  }

  // Missing env var (common Nest/config patterns)
  const env = rawLog.match(/(?:environment variable|env var|process\.env)\s*["']?([A-Z0-9_]{3,})["']?\s*(?:is )?(?:not set|missing|required|undefined)/i);
  if (env) {
    return { service: serviceName, kind: 'missing-env', detail: `Missing environment variable: ${env[1]}.`, rawLog: trimmed };
  }

  if (kindHint) {
    return { service: serviceName, kind: kindHint, detail: `${serviceName}: ${firstErrorLine(rawLog) || kindHint}.`, rawLog: trimmed };
  }

  return { service: serviceName, kind: 'unknown', detail: `${serviceName} failed to start: ${firstErrorLine(rawLog) || 'unknown error'}.`, rawLog: trimmed };
}

function firstErrorLine(log: string): string {
  const line = log
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /error|cannot|unable|failed|exception/i.test(l));
  return (line || '').slice(0, 200);
}

/** Best-effort: turn an absolute/odd path into a repo-root-relative file path. */
function normalizeRepoFile(file?: string): string | undefined {
  if (!file) return undefined;
  const cleaned = file.replace(/^["']|["']$/g, '').trim();
  // Keep the last path segments after a known app dir if present.
  const m = cleaned.match(/((?:kubo-mobile|infra-red|app|src)\/[^\s:]+)/);
  return m ? m[1] : cleaned;
}

interface StartSuccess {
  proc: ChildProcess;
  log: string;
}

/**
 * Start a single service: ensure deps, wait for ANY ready signal, then (for
 * services with a bundleCheckCommand) compile the bundle first to surface
 * import/compile errors that the dev server hides until first request.
 */
async function startService(
  service: RuntimeServiceConfig,
  onLog?: RuntimeLogFn,
): Promise<StartSuccess | { failure: RuntimeFailure }> {
  const nodeModulesCheck = await ensureNodeModules(service, onLog);
  if (!nodeModulesCheck.ok) {
    await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${nodeModulesCheck.error}`);
    return { failure: classifyFailure(service.name, nodeModulesCheck.error, 'prereq-missing') };
  }

  // ── Bundle verification (B1): compile the bundle BEFORE starting the dev server.
  // This surfaces "Unable to resolve"/compile errors deterministically, without
  // depending on the dev server or guessing the Metro bundle URL.
  if (service.bundleCheckCommand) {
    const bundleFailure = await runBundleCheck(service, onLog);
    if (bundleFailure) return { failure: bundleFailure };
  }

  await killPort(service.port);

  const [cmd, ...args] = service.startCommand.split(' ');
  await emitRuntimeLog(onLog, `🌐 [runtime:${service.name}] Starting \`${service.startCommand}\` in ${service.cwd}`);

  const env = { ...process.env, ...service.env, CI: '1' };
  const proc = spawn(cmd, args, { cwd: service.cwd, stdio: 'pipe', env });
  activeProcesses.push(proc);

  let serviceLog = '';
  const onOutput = (data: Buffer | string) => {
    serviceLog += data.toString();
  };
  proc.stdout?.on('data', onOutput);
  proc.stderr?.on('data', onOutput);

  const matchesReady = () => service.readySignals.some((sig) => serviceLog.includes(sig));

  const ready = await new Promise<boolean>((resolve) => {
    let resolved = false;
    const finish = (val: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(val);
      }
    };
    const checkReady = () => {
      if (!resolved && matchesReady()) finish(true);
    };
    proc.stdout?.on('data', checkReady);
    proc.stderr?.on('data', checkReady);
    proc.on('exit', () => finish(false));
    setTimeout(() => finish(false), service.timeoutMs);
    checkReady();
  });

  if (!ready) {
    const exited = proc.exitCode !== null;
    const kindHint: RuntimeFailureKind = exited ? 'unknown' : 'timeout';
    const detail = exited
      ? `${service.name} exited before ready. Exit code: ${proc.exitCode}.`
      : `${service.name} did not emit a ready signal within ${service.timeoutMs}ms.`;
    await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] ${detail}`);
    return { failure: classifyFailure(service.name, `${detail}\n${serviceLog}`, kindHint) };
  }

  await emitRuntimeLog(onLog, `✅ [runtime:${service.name}] Ready on port ${service.port}.`);
  return { proc, log: serviceLog };
}

/**
 * Run the bundle-check command (e.g. `npx expo export`) to compile the bundle and
 * surface errors deterministically. Returns a classified RuntimeFailure if the
 * command fails or its output has a Metro/compiler error signature, else null.
 *
 * This replaces the old HTTP "probe" approach, which was fragile: the Metro
 * bundle URL changed across Expo versions (index.bundle vs expo-router/entry vs
 * a virtual entry), causing false 404s. `expo export` is the official way.
 */
const BUNDLE_ERROR_SIGNATURE =
  /Unable to resolve|Cannot find module|UnableToResolveError|error TS\d+|SyntaxError|Failed to compile|Metro encountered an error|Cannot resolve/i;

async function runBundleCheck(
  service: RuntimeServiceConfig,
  onLog?: RuntimeLogFn,
): Promise<RuntimeFailure | null> {
  const cmd = service.bundleCheckCommand!;
  await emitRuntimeLog(onLog, `🧪 [runtime:${service.name}] Verifying bundle: \`${cmd}\` (this can take a while)...`);

  try {
    const { stdout, stderr } = await execPromise(cmd, {
      cwd: service.cwd,
      timeout: 240_000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, ...service.env, CI: '1' },
    });
    const out = `${stdout}\n${stderr}`;
    // Some tools exit 0 but still print resolution errors — check the output too.
    if (BUNDLE_ERROR_SIGNATURE.test(out)) {
      await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] Bundle check reported errors.`);
      return classifyFailure(service.name, out);
    }
    await emitRuntimeLog(onLog, `✅ [runtime:${service.name}] Bundle compiled cleanly.`);
    return null;
  } catch (err: any) {
    // Non-zero exit: stdout/stderr carry the real error (e.g. "Unable to resolve").
    const out = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
    await emitRuntimeLog(onLog, `❌ [runtime:${service.name}] Bundle check failed (exit ${err?.code ?? '?'}).`);
    return classifyFailure(service.name, out);
  } finally {
    // Clean the throwaway export output so it never lands in a commit/diff.
    try {
      const outDir = path.join(service.cwd, '.unity-bundle-check');
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Run the config-driven runtime gate.
 *
 * Starts all services (backends first, frontends second), links backend URL into
 * the frontend, forces a bundle on bundle-probe services, and returns a structured
 * result with classified failures for auto-healing.
 */
export async function runProjectRuntimeGate(
  workspace: PreparedWorkspace,
  targetRoute = '/',
  onLog?: RuntimeLogFn,
): Promise<RuntimeGateResult> {
  cleanupActiveProcesses();

  const manifest = resolveRuntimeManifest(workspace.repoPath, workspace.expoPath, workspace.apiPath);

  if (manifest.services.length === 0) {
    await emitRuntimeLog(onLog, `🌐 [runtime] No runtime services detected. Skipping.`);
    return {
      localUrl: null,
      publicUrl: null,
      details: 'No runtime-capable app detected. Skipping runtime gate.',
      status: 'passed',
      failures: [],
    };
  }

  const ip = getLocalIpAddress();

  const sorted = [...manifest.services].sort((a, b) => {
    const order = { backend: 0, generic: 1, frontend: 2 };
    return (order[a.type] ?? 1) - (order[b.type] ?? 1);
  });

  await emitRuntimeLog(
    onLog,
    `🌐 [runtime] Preflight: ${sorted.length} service(s) to start: ${sorted.map((s) => `${s.name}(${s.type}:${s.port})`).join(', ')}`,
  );

  for (const service of sorted) {
    await killPort(service.port);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  let backendUrl: string | null = null;

  for (const service of sorted) {
    if (manifest.linkBackendToFrontend && service.type === 'frontend' && backendUrl) {
      injectEnvVar(service.cwd, manifest.backendUrlEnvVar, backendUrl);
      await emitRuntimeLog(onLog, `🌐 [runtime] Injected ${manifest.backendUrlEnvVar}=${backendUrl} into ${service.cwd}/.env`);
    }

    const result = await startService(service, onLog);

    if ('failure' in result) {
      // One service failing fails the gate, but we return the STRUCTURED failure.
      return {
        localUrl: null,
        publicUrl: null,
        details: result.failure.detail,
        status: 'failed',
        failures: [result.failure],
      };
    }

    if (service.type === 'backend') {
      backendUrl = ip ? `http://${ip}:${service.port}` : `http://localhost:${service.port}`;
    }
  }

  const primary = sorted.find((s) => s.type === 'frontend') || sorted[0];
  const route = targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`;
  const localUrl = `http://localhost:${primary.port}${route}`;
  const publicUrl = ip ? `http://${ip}:${primary.port}${route}` : null;

  await emitRuntimeLog(onLog, `✅ [runtime] All ${sorted.length} service(s) healthy. Primary: ${localUrl}`);

  return {
    localUrl,
    publicUrl,
    details: `Runtime available at ${localUrl}. Services: ${sorted.map((s) => s.name).join(', ')}.`,
    status: 'passed',
    failures: [],
  };
}
