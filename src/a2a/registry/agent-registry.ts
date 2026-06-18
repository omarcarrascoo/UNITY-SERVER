/**
 * Agent Registry — the catalog the router dispatches over.
 *
 * Each entry describes a routable agent: its A2A endpoint, what it does, and
 * routing hints (keywords for the deterministic fallback + a one-line capability
 * description for the LLM classifier). This is the seed of the "agent company":
 * adding a new agent = adding an entry here + standing up its A2A server.
 *
 * See planning-docs/AGENT_COMPANY_VISION.md §1.
 */
import { PORTS, rpcUrl } from '../server/ports.js';

export interface RegisteredAgent {
  /** Stable id used by the router/UI (e.g. 'dev-squad'). */
  id: string;
  /** Human label. */
  name: string;
  /** A2A JSON-RPC endpoint to dispatch to. */
  url: string;
  /** One-line capability description — fed to the LLM classifier. */
  capability: string;
  /** Keywords for the deterministic fallback classifier (lowercased match). */
  keywords: string[];
  /** Whether this agent can receive a free-text prompt directly (vs. needing a structured delegation). */
  acceptsPrompt: boolean;
}

/**
 * The catalog. NOTE: the Dev Squad's real entry point is the autonomous-run
 * orchestrator (it needs a worktree + planning), not a raw prompt to its A2A
 * server — so `acceptsPrompt: false`. The router routes TO it but the dispatch
 * path differs (handled by the caller). Marketing / Research take a prompt directly.
 */
const AGENTS: RegisteredAgent[] = [
  {
    id: 'dev-squad',
    name: 'Dev Squad',
    url: rpcUrl(PORTS.devSquad),
    capability:
      'Writes, fixes, and refactors application code. Use for building features, fixing bugs, implementing UI/screens/APIs, or any change to the codebase.',
    keywords: [
      'build', 'implement', 'fix', 'bug', 'code', 'refactor', 'feature', 'screen',
      'endpoint', 'api', 'ui', 'component', 'develop', 'construye', 'implementa',
      'corrige', 'arregla', 'desarrolla', 'crea', 'pantalla', 'función', 'funcion',
    ],
    acceptsPrompt: false,
  },
  {
    id: 'marketing',
    name: 'Marketing Squad',
    url: rpcUrl(PORTS.marketing),
    capability:
      'Drafts marketing/social content and posts it (after human approval). Use for posts, campaigns, announcements, copywriting, social media.',
    keywords: [
      'post', 'campaign', 'campaña', 'marketing', 'social', 'tweet', 'announce',
      'anuncia', 'publica', 'contenido', 'copy', 'promote', 'promociona', 'redes',
    ],
    acceptsPrompt: true,
  },
  {
    id: 'market-research',
    name: 'Market Research',
    url: rpcUrl(PORTS.marketResearch),
    capability:
      'Researches and analyzes a market, competitors, trends, or opportunities. Use for market analysis, competitor research, sizing, or "investigate X".',
    keywords: [
      'research', 'market', 'mercado', 'investiga', 'investigar', 'análisis', 'analisis',
      'analiza', 'competitor', 'competencia', 'trend', 'tendencia', 'opportunity', 'oportunidad',
    ],
    acceptsPrompt: true,
  },
];

export function listAgents(): RegisteredAgent[] {
  return AGENTS;
}

export function getAgent(id: string): RegisteredAgent | null {
  return AGENTS.find((a) => a.id === id) ?? null;
}
