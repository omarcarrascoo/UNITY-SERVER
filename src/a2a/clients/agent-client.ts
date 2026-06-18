/**
 * Generic A2A client — send a free-text prompt to ANY agent by its base URL and
 * stream the result. Used by the router to dispatch to whichever agent it chose
 * (marketing, market-research, etc.).
 *
 * The agent's AgentCard `url` is the JSON-RPC endpoint (e.g.
 * http://127.0.0.1:5002/a2a/jsonrpc); A2AClient.fromCardUrl wants the agent-card
 * URL, so we derive the base from the rpc url.
 */
import { randomUUID } from 'crypto';
import { A2AClient } from '@a2a-js/sdk/client';
import type { MessageSendParams } from '@a2a-js/sdk';

export interface DispatchResult {
  terminalState: string | null;
  /** Text of the final/most-relevant artifact, if any. */
  artifactText: string | null;
  /** All status notes seen (for surfacing progress). */
  notes: string[];
}

/** Turn an A2A rpc url (.../a2a/jsonrpc) into the agent-card url. */
function cardUrlFromRpc(rpcUrl: string): string {
  const base = rpcUrl.replace(/\/a2a\/jsonrpc\/?$/, '');
  return `${base}/.well-known/agent-card.json`;
}

/**
 * Send `prompt` to the agent at `rpcUrl` and consume its event stream.
 * Returns the terminal state + the text of the last artifact + progress notes.
 */
export async function dispatchPrompt(
  rpcUrl: string,
  prompt: string,
  onProgress?: (message: string) => void | Promise<void>,
): Promise<DispatchResult> {
  const client = await A2AClient.fromCardUrl(cardUrlFromRpc(rpcUrl));
  const params: MessageSendParams = {
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: prompt }],
    },
  };

  let terminalState: string | null = null;
  let artifactText: string | null = null;
  const notes: string[] = [];

  for await (const event of client.sendMessageStream(params)) {
    if (event.kind === 'status-update') {
      const note = event.status.message?.parts.find((p) => p.kind === 'text')?.text;
      if (note) {
        notes.push(note);
        if (onProgress) await onProgress(note);
      }
      if (event.final) terminalState = event.status.state;
    } else if (event.kind === 'artifact-update') {
      const text = event.artifact.parts.find((p) => p.kind === 'text')?.text;
      if (text) artifactText = text;
    }
  }

  return { terminalState, artifactText, notes };
}
