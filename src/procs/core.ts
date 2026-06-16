/**
 * `core` process entrypoint (Phase A).
 *
 * Everything index.ts did — Discord bot + HTTP panel — PLUS the PM Agent's A2A
 * server. The PM lives here on purpose: co-located with Discord (for approvals)
 * and unityStore (the SQLite owner). The Dev Squad runs as a SEPARATE process
 * (src/procs/dev-squad.ts).
 *
 * Run: `npm run dev` (starts core + dev-squad via concurrently) or
 *      `npm run dev:core` (this process only).
 */
import { Client, GatewayIntentBits } from 'discord.js';
import 'dotenv/config';
import { getRuntimeConfig, WORKSPACE_DIR } from '../config.js';
import { RuntimeState } from '../runtime/state.js';
import { registerDiscordHandlers } from '../transports/discord/register-handlers.js';
import { startUnityHttpServer } from '../transports/http/server.js';
import { startA2AServer } from '../a2a/server/a2a-server.js';
import { pmAgentCard } from '../a2a/cards/pm.card.js';
import { PMExecutor } from '../a2a/executors/pm.executor.js';
import { PORTS } from '../a2a/server/ports.js';

const config = getRuntimeConfig();
const runtime = new RuntimeState();
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

console.log('BOOT DEBUG', {
  proc: 'core',
  cwd: process.cwd(),
  workspaceDir: WORKSPACE_DIR,
  githubRepo: config.githubRepo,
  targetRepoPath: runtime.getActiveProject().repoPath,
});

registerDiscordHandlers(client, runtime);
startUnityHttpServer(runtime);
startA2AServer(pmAgentCard, new PMExecutor(runtime), PORTS.pm);

client.login(config.discordToken);
console.log('🤖 Jarvis Architect listening on Discord (core process)...');
