/**
 * Typed A2A client that `core` (the PM) uses to reach the Dev Squad process.
 *
 * Lazily resolves the Dev Squad's AgentCard over HTTP and caches the client.
 * `sendDelegation` encodes a serializable DelegationPayload and returns the
 * raw A2A event stream — callers pipe it through the task-bridge (§8) to mirror
 * lifecycle into unityStore.
 */
import { A2AClient } from '@a2a-js/sdk/client';
import type { MessageSendParams } from '@a2a-js/sdk';
import { DEV_SQUAD_BASE_URL } from '../server/ports.js';
import { encodeDelegation, type DelegationPayload } from '../shared/delegation.js';

let cached: A2AClient | null = null;

/** Resolve (and cache) the Dev Squad A2A client. */
export async function getDevSquadClient(): Promise<A2AClient> {
  if (!cached) {
    cached = await A2AClient.fromCardUrl(`${DEV_SQUAD_BASE_URL}/.well-known/agent-card.json`);
  }
  return cached;
}

/**
 * Delegate a scoped task to the Dev Squad and stream its lifecycle events.
 * The returned AsyncGenerator yields Task / status-update / artifact-update /
 * message events (discriminated by `.kind`).
 */
export async function sendDelegation(payload: DelegationPayload) {
  const client = await getDevSquadClient();
  const params: MessageSendParams = { message: encodeDelegation(payload) };
  return client.sendMessageStream(params);
}

/** Reset the cached client (e.g. if the Dev Squad restarts). Mainly for tests. */
export function resetDevSquadClient(): void {
  cached = null;
}
