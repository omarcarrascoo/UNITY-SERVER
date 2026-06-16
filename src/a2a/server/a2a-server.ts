/**
 * Shared helper: stand up any agent as a spec-compliant A2A server.
 *
 * Mounts JSON-RPC + agent-card discovery on an Express app bound to localhost.
 * Used by both process entrypoints (procs/core.ts for the PM, procs/dev-squad.ts
 * for the Dev Squad). No authentication in Phase A — localhost only; auth is a
 * Phase E concern when agents leave the host.
 */
import express from 'express';
import type { Server } from 'http';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentCard } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { HOST, A2A_RPC_PATH } from './ports.js';

export interface A2AServerHandle {
  card: AgentCard;
  port: number;
  server: Server;
}

/**
 * Start an A2A server for `card`/`executor` on `port`.
 *
 * The SDK's InMemoryTaskStore handles protocol-level task bookkeeping inside
 * this process; it is NOT brain-station's durable store. The `core` process
 * mirrors meaningful lifecycle events into unityStore via the task-bridge.
 */
export function startA2AServer(
  card: AgentCard,
  executor: AgentExecutor,
  port: number,
): A2AServerHandle {
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);

  const app = express();
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use(A2A_RPC_PATH, jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  const server = app.listen(port, HOST, () => {
    console.log(`🛰️  ${card.name} A2A server on http://${HOST}:${port}`);
    console.log(`   ↳ AgentCard: http://${HOST}:${port}/${AGENT_CARD_PATH}`);
  });

  return { card, port, server };
}
