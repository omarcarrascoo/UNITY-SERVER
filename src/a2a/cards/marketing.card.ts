/**
 * AgentCard for the Marketing Squad — the first real consumer of the Approval
 * Gateway. It drafts content (e.g. a social post) and MUST get human approval
 * via Discord before any outward/public action (posting, ads).
 */
import type { AgentCard } from '@a2a-js/sdk';
import { PORTS, rpcUrl } from '../server/ports.js';

export const marketingAgentCard: AgentCard = {
  name: 'Marketing Squad',
  description:
    'Drafts marketing content and posts to channels — but always requests human authorization via Discord before publishing.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: rpcUrl(PORTS.marketing),
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'draft-and-post',
      name: 'Draft and Post',
      description: 'Draft a social post from a brief and publish it after human approval.',
      tags: ['marketing', 'content', 'approval-gated'],
    },
  ],
};
