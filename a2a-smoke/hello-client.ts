/**
 * A2A Phase A — Step 1 smoke test: the "core-like" CLIENT process.
 * Resolves the hello agent's card over HTTP, then streams a task to completion.
 * NOT brain-station code — throwaway. Mirrors the shape of the future dev-squad.client.
 *
 * Exits non-zero if the round-trip fails, so it doubles as a CI/manual pass-fail check.
 */
import { randomUUID } from 'crypto';
import { A2AClient } from '@a2a-js/sdk/client';
import type { MessageSendParams } from '@a2a-js/sdk';
import { HELLO_PORT } from './hello-card.js';

const BASE_URL = `http://127.0.0.1:${HELLO_PORT}`;

async function waitForServer(retries = 20, delayMs = 250): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`hello-server never became reachable at ${BASE_URL}`);
}

async function main(): Promise<void> {
  console.log('🔌 [hello-client] waiting for hello-server...');
  await waitForServer();

  // 1. Resolve the agent card over HTTP (proves discovery works).
  const client = await A2AClient.fromCardUrl(`${BASE_URL}/.well-known/agent-card.json`);
  const card = await client.getAgentCard();
  console.log(`🔌 [hello-client] resolved AgentCard: "${card.name}" v${card.version}`);

  // 2. Stream a task to completion (proves JSON-RPC + SSE streaming works).
  const params: MessageSendParams = {
    message: {
      kind: 'message',
      messageId: randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: 'ping from core process' }],
    },
  };

  let sawWorking = false;
  let sawArtifact = false;
  let sawCompleted = false;

  for await (const event of client.sendMessageStream(params)) {
    if (event.kind === 'task') {
      console.log(`   ↪ task created: ${event.id} (status: ${event.status.state})`);
    } else if (event.kind === 'status-update') {
      console.log(`   ↪ status: ${event.status.state}${event.final ? ' (final)' : ''}`);
      if (event.status.state === 'working') sawWorking = true;
      if (event.status.state === 'completed') sawCompleted = true;
    } else if (event.kind === 'artifact-update') {
      const text = event.artifact.parts.find((p) => p.kind === 'text')?.text ?? '';
      console.log(`   ↪ artifact "${event.artifact.artifactId}": ${text}`);
      sawArtifact = true;
    } else if (event.kind === 'message') {
      const text = event.parts.find((p) => p.kind === 'text')?.text ?? '';
      console.log(`   ↪ message: ${text}`);
    }
  }

  if (sawWorking && sawArtifact && sawCompleted) {
    console.log('\n✅ [hello-client] SMOKE TEST PASSED — working + artifact + completed all received over A2A/HTTP.');
    process.exit(0);
  } else {
    console.error(
      `\n❌ [hello-client] SMOKE TEST FAILED — working:${sawWorking} artifact:${sawArtifact} completed:${sawCompleted}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ [hello-client] error:', err);
  process.exit(1);
});
