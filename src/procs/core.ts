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
import { marketingAgentCard } from '../a2a/cards/marketing.card.js';
import { MarketingExecutor } from '../a2a/executors/marketing.executor.js';
import { marketResearchAgentCard } from '../a2a/cards/market-research.card.js';
import { MarketResearchExecutor } from '../a2a/executors/market-research.executor.js';
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
// Marketing Squad lives in core too: it uses the Approval Gateway, which needs
// the Discord client that's registered here.
startA2AServer(marketingAgentCard, new MarketingExecutor(), PORTS.marketing);
startA2AServer(marketResearchAgentCard, new MarketResearchExecutor(), PORTS.marketResearch);

// Discord runs over Cloudflare; a flaky network at boot makes login() reject
// (UND_ERR_CONNECT_TIMEOUT). Swallow it so a Discord hiccup never takes down
// the HTTP console / A2A servers that the rest of the system (and the mobile
// app) depend on. Discord.js keeps retrying its own connection.
client
  .login(config.discordToken)
  .then(() => console.log('🤖 Jarvis Architect listening on Discord (core process)...'))
  .catch((err) => {
    console.error('⚠️ Discord login failed (continuing without Discord):', err?.message || err);
  });
