/**
 * A2A Phase A — Step 1 smoke test.
 * Throwaway AgentCard for a "hello" agent. NOT brain-station code.
 * Verifies @a2a-js/sdk@0.3.13 works in this ESM/tsx setup across two processes.
 */
import type { AgentCard } from '@a2a-js/sdk';

export const HELLO_PORT = 5001;

export const helloAgentCard: AgentCard = {
  name: 'Hello Agent',
  description: 'Throwaway agent that proves the A2A SDK works across processes.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: `http://127.0.0.1:${HELLO_PORT}/a2a/jsonrpc`,
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'say-hello',
      name: 'Say Hello',
      description: 'Echoes a greeting and streams a couple of status updates.',
      tags: ['demo'],
    },
  ],
};
