/**
 * AgentCard for the Market Research agent — a routable analysis agent.
 * Takes a topic/question and returns a market/competitor analysis (LLM-backed).
 * In the future it will also FILE tickets (see AGENT_COMPANY_VISION.md §5).
 */
import type { AgentCard } from '@a2a-js/sdk';
import { PORTS, rpcUrl } from '../server/ports.js';

export const marketResearchAgentCard: AgentCard = {
  name: 'Market Research',
  description: 'Researches and analyzes markets, competitors, trends, and opportunities for a project.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: rpcUrl(PORTS.marketResearch),
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'analyze-market',
      name: 'Analyze Market',
      description: 'Produce a concise market/competitor/trend analysis for a given topic.',
      tags: ['research', 'market', 'analysis'],
    },
  ],
};
