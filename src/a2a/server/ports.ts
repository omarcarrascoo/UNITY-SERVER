/**
 * Central port + URL registry for A2A agents.
 *
 * Phase A topology (single host, 2 processes):
 *   - PM Agent A2A server lives INSIDE the `core` process.
 *   - Dev Squad A2A server is its own process.
 *
 * All bind to 127.0.0.1 (localhost-only). Overridable via env so deployments
 * can relocate ports without code changes. Multi-host is a later phase.
 */

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const PORTS = {
  pm: envPort('A2A_PM_PORT', 5000),
  devSquad: envPort('A2A_DEV_SQUAD_PORT', 5001),
} as const;

export const HOST = '127.0.0.1';

/** JSON-RPC endpoint path mounted by startA2AServer. */
export const A2A_RPC_PATH = '/a2a/jsonrpc';

/** Build the JSON-RPC URL an AgentCard should advertise for a given port. */
export function rpcUrl(port: number): string {
  return `http://${HOST}:${port}${A2A_RPC_PATH}`;
}

/**
 * Where the `core` process reaches the Dev Squad. Defaults to the local
 * Dev Squad port but can point elsewhere (e.g. another host) via env.
 */
export const DEV_SQUAD_BASE_URL =
  process.env.A2A_DEV_SQUAD_URL || `http://${HOST}:${PORTS.devSquad}`;
