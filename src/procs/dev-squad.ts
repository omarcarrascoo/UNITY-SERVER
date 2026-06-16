/**
 * `dev-squad` process entrypoint (Phase A).
 *
 * A standalone A2A server wrapping the Explorer→Architect→Implementer pipeline.
 * Stateless: no Discord, no HTTP panel, no SQLite. It receives delegations over
 * A2A, works against a git worktree path, and reports results as A2A events.
 *
 * Run: `npm run dev` (with core, via concurrently) or `npm run dev:dev-squad`.
 */
import 'dotenv/config';
import { startA2AServer } from '../a2a/server/a2a-server.js';
import { devSquadAgentCard } from '../a2a/cards/dev-squad.card.js';
import { DevSquadExecutor } from '../a2a/executors/dev-squad.executor.js';
import { PORTS } from '../a2a/server/ports.js';

console.log('BOOT DEBUG', { proc: 'dev-squad', cwd: process.cwd() });

startA2AServer(devSquadAgentCard, new DevSquadExecutor(), PORTS.devSquad);

console.log('🛠️  Dev Squad ready (dev-squad process)...');
