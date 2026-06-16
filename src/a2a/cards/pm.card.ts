/**
 * AgentCard for the PM Agent — the orchestrator the human (Discord/panel) talks to.
 * Hosted INSIDE the `core` process so approvals can reuse Discord without a webhook.
 */
import type { AgentCard } from '@a2a-js/sdk';
import { PORTS, rpcUrl } from '../server/ports.js';

export const pmAgentCard: AgentCard = {
  name: 'PM Agent',
  description:
    'Receives an objective, plans it, delegates to squads, tracks status, and brokers human approvals.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: rpcUrl(PORTS.pm),
  capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'run-initiative',
      name: 'Run Initiative',
      description: 'Plan and execute a development objective end to end.',
      tags: ['planning', 'orchestration'],
    },
    {
      id: 'report-status',
      name: 'Report Status',
      description: 'Return the current state of a run/initiative.',
      tags: ['tracking'],
    },
  ],
};
