/**
 * AgentCard for the Dev Squad — a separate process wrapping the existing
 * Explorer→Architect→Implementer pipeline. Stateless: touches the git worktree
 * by path, never opens SQLite, never commits/pushes (core owns integration).
 */
import type { AgentCard } from '@a2a-js/sdk';
import { PORTS, rpcUrl } from '../server/ports.js';

export const devSquadAgentCard: AgentCard = {
  name: 'Dev Squad',
  description:
    'Explorer→Architect→Implementer→Reviewer pipeline that turns a scoped task into a committed diff.',
  protocolVersion: '0.3.0',
  version: '0.1.0',
  url: rpcUrl(PORTS.devSquad),
  capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'implement-task',
      name: 'Implement Task',
      description:
        'Given a scoped instruction + writeScope + worktree path, produce a validated commit.',
      tags: ['code', 'implement'],
    },
  ],
};
