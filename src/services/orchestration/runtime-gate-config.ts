/**
 * Runtime Gate Configuration — replaces hardcoded Expo/NestJS detection
 * with a config-driven approach.
 *
 * Config can be:
 * 1. Auto-detected from package.json dependencies (backward-compatible)
 * 2. Manually specified in `.unity/gates.json`
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export interface RuntimeServiceConfig {
  /** Display name for logs */
  name: string;
  /** Working directory relative to repo root (e.g. "apps/mobile", "apps/api") */
  cwd: string;
  /** Command to start the service */
  startCommand: string;
  /**
   * Substring(s) in stdout/stderr that signal readiness. ANY match counts.
   * Multiple patterns make detection robust across tool-version output changes.
   */
  readySignals: string[];
  /** Port the service listens on */
  port: number;
  /** Optional health check URL to verify after readySignal */
  healthCheck?: string;
  /** Max time to wait for readySignal (ms) */
  timeoutMs: number;
  /** Whether this service requires node_modules to be present */
  requiresNodeModules: boolean;
  /** Service type hint for special handling */
  type: 'frontend' | 'backend' | 'generic';
  /** Environment variables to inject before starting */
  env?: Record<string, string>;
  /**
   * Optional bundle-verification COMMAND run BEFORE starting the dev server
   * (e.g. `npx expo export --platform web`). This is the official, robust way to
   * surface bundling errors ("Unable to resolve module", compile errors) that a
   * dev server hides until first request — and it doesn't depend on guessing the
   * Metro bundle URL (which changes across Expo versions). Non-zero exit OR a
   * Metro error signature in the output fails the service with a classified error.
   */
  bundleCheckCommand?: string;
}

/** Frontend services get a longer window — JS bundling of a real app is slow. */
const FRONTEND_TIMEOUT_MS = 120_000;

export interface RuntimeGateManifest {
  /** Services to start, in order (backends first, frontends second) */
  services: RuntimeServiceConfig[];
  /** If true, inject backend URL into frontend .env */
  linkBackendToFrontend: boolean;
  /** Environment variable name for injecting backend URL into frontend */
  backendUrlEnvVar: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function getLocalIpAddress(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

/**
 * Try to load a manual config from `.unity/gates.json`.
 */
function loadManualConfig(repoPath: string): RuntimeGateManifest | null {
  const configPath = path.join(repoPath, '.unity', 'gates.json');
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw.services || !Array.isArray(raw.services)) return null;

    return {
      services: raw.services.map((s: any) => {
        const type = s.type || 'generic';
        // Accept readySignals[] (new), readySignal (legacy single), or default.
        const signals: string[] = Array.isArray(s.readySignals)
          ? s.readySignals
          : [s.readySignal || s.ready_signal || 'listening'];
        return {
          name: s.name || 'service',
          cwd: s.cwd || '.',
          startCommand: s.startCommand || s.start_command || 'npm start',
          readySignals: signals,
          port: Number(s.port) || 3000,
          healthCheck: s.healthCheck || s.health_check,
          timeoutMs:
            Number(s.timeoutMs || s.timeout_ms) ||
            (type === 'frontend' ? FRONTEND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
          requiresNodeModules: s.requiresNodeModules !== false,
          type,
          env: s.env,
          bundleCheckCommand: s.bundleCheckCommand || s.bundle_check_command,
        };
      }),
      linkBackendToFrontend: raw.linkBackendToFrontend ?? raw.link_backend_to_frontend ?? false,
      backendUrlEnvVar: raw.backendUrlEnvVar || raw.backend_url_env_var || 'EXPO_PUBLIC_API_URL',
    };
  } catch {
    return null;
  }
}

/**
 * Read package.json from a directory and return parsed content.
 */
function readPackageJson(dir: string): Record<string, any> | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
}

function hasExpoApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(pkg?.dependencies?.expo || pkg?.devDependencies?.expo);
}


function hasNestApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(
    pkg?.dependencies?.['@nestjs/core'] || pkg?.devDependencies?.['@nestjs/core'],
  );
}

function hasNextApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(pkg?.dependencies?.next || pkg?.devDependencies?.next);
}

function hasViteApp(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return Boolean(pkg?.dependencies?.vite || pkg?.devDependencies?.vite);
}

/**
 * Auto-detect runtime services from the workspace structure.
 * Backward-compatible with the existing Expo/NestJS detection.
 */
function autoDetectServices(
  repoPath: string,
  expoPath: string,
  apiPath: string | null,
): RuntimeServiceConfig[] {
  const services: RuntimeServiceConfig[] = [];
  const ip = getLocalIpAddress();

  // Backend detection
  if (apiPath) {
    if (hasNestApp(apiPath)) {
      services.push({
        name: 'nestjs-api',
        cwd: apiPath,
        startCommand: 'npm run start',
        readySignals: [
          'Nest application successfully started',
          'Application is running on',
        ],
        port: 3000,
        healthCheck: ip ? `http://${ip}:3000` : 'http://localhost:3000',
        timeoutMs: DEFAULT_TIMEOUT_MS,
        requiresNodeModules: true,
        type: 'backend',
      });
    } else {
      // Generic Node.js backend
      const pkg = readPackageJson(apiPath);
      if (pkg?.scripts?.start || pkg?.scripts?.['start:dev']) {
        const startScript = pkg.scripts['start:dev'] ? 'npm run start:dev' : 'npm run start';
        services.push({
          name: 'api',
          cwd: apiPath,
          startCommand: startScript,
          readySignals: ['listening', 'Server running', 'started on'],
          port: 3000,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          requiresNodeModules: true,
          type: 'backend',
        });
      }
    }
  }

  // Frontend detection
  if (hasExpoApp(expoPath)) {
    services.push({
      name: 'expo-web',
      cwd: expoPath,
      startCommand: 'npx expo start --web --port 8081',
      // Expo CLI / Metro output varies by version; match any of these.
      readySignals: [
        'Waiting on http',
        'Web is waiting',
        'Logs for your project',
        'Bundled ',
        'ready in',
        'Metro waiting',
      ],
      port: 8081,
      timeoutMs: FRONTEND_TIMEOUT_MS,
      requiresNodeModules: true,
      type: 'frontend',
      // Verify the web bundle compiles via the official export command — surfaces
      // "Unable to resolve module"/compile errors without guessing the Metro URL.
      bundleCheckCommand: 'npx expo export --platform web --output-dir .unity-bundle-check',
    });
  } else if (hasNextApp(expoPath)) {
    services.push({
      name: 'nextjs',
      cwd: expoPath,
      startCommand: 'npm run dev',
      readySignals: ['Ready in', 'started server on', 'Local:'],
      port: 3000,
      timeoutMs: FRONTEND_TIMEOUT_MS,
      requiresNodeModules: true,
      type: 'frontend',
      bundleCheckCommand: 'npm run build',
    });
  } else if (hasViteApp(expoPath)) {
    services.push({
      name: 'vite',
      cwd: expoPath,
      startCommand: 'npm run dev',
      readySignals: ['ready in', 'Local:', 'VITE v'],
      port: 5173,
      timeoutMs: FRONTEND_TIMEOUT_MS,
      requiresNodeModules: true,
      type: 'frontend',
      bundleCheckCommand: 'npm run build',
    });
  }

  return services;
}

/**
 * Resolve the runtime gate manifest for a workspace.
 * Tries manual config first, falls back to auto-detection.
 */
export function resolveRuntimeManifest(
  repoPath: string,
  expoPath: string,
  apiPath: string | null,
): RuntimeGateManifest {
  // Try manual config first
  const manual = loadManualConfig(repoPath);
  if (manual && manual.services.length > 0) {
    // Resolve relative cwd paths to absolute
    manual.services = manual.services.map((s) => ({
      ...s,
      cwd: path.isAbsolute(s.cwd) ? s.cwd : path.join(repoPath, s.cwd),
    }));
    return manual;
  }

  // Auto-detect
  const services = autoDetectServices(repoPath, expoPath, apiPath);
  const hasBackend = services.some((s) => s.type === 'backend');
  const hasFrontend = services.some((s) => s.type === 'frontend');

  return {
    services,
    linkBackendToFrontend: hasBackend && hasFrontend,
    backendUrlEnvVar: 'EXPO_PUBLIC_API_URL',
  };
}

export { getLocalIpAddress };
