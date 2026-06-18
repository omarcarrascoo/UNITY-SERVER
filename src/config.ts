import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import type { WorkspaceProject } from './domain/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const WORKSPACE_DIR = path.resolve(PROJECT_ROOT, 'workspaces');
export const DATA_DIR = path.resolve(PROJECT_ROOT, '.unity');

export interface RuntimeConfig {
  workspaceDir: string;
  dataDir: string;
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  githubBaseBranch: string;
  discordToken: string;
  discordClientId: string;
  figmaToken?: string;
  deepseekApiKey?: string;
  manualChannelName: string;
  autonomousChannelName: string;
  /** Channel for ticket lifecycle notifications. Falls back to autonomous. */
  ticketsChannelName: string;
  /** Channel for agent authorization requests (marketing, etc). Falls back to autonomous. */
  approvalsChannelName: string;
  integrationBranchName: string;
  localConsolePort: number;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getRuntimeConfig(): RuntimeConfig {
  return {
    workspaceDir: WORKSPACE_DIR,
    dataDir: DATA_DIR,
    githubOwner: getRequiredEnv('GITHUB_OWNER'),
    githubRepo: getRequiredEnv('GITHUB_REPO'),
    githubToken: getRequiredEnv('GITHUB_TOKEN'),
    githubBaseBranch: process.env.GITHUB_BASE_BRANCH || 'main',
    discordToken: getRequiredEnv('DISCORD_TOKEN'),
    discordClientId: getRequiredEnv('DISCORD_CLIENT_ID'),
    figmaToken: process.env.FIGMA_TOKEN,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    manualChannelName: process.env.UNITY_MANUAL_CHANNEL || 'jarvis-dev',
    autonomousChannelName: process.env.UNITY_AUTONOMOUS_CHANNEL || 'unity-agent',
    // Dedicated channels; fall back to the autonomous channel when unset so the
    // system keeps working even if the channels haven't been created yet.
    ticketsChannelName:
      process.env.UNITY_TICKETS_CHANNEL || process.env.UNITY_AUTONOMOUS_CHANNEL || 'unity-agent',
    approvalsChannelName:
      process.env.UNITY_APPROVALS_CHANNEL || process.env.UNITY_AUTONOMOUS_CHANNEL || 'unity-agent',
    integrationBranchName: process.env.UNITY_INTEGRATION_BRANCH || 'unity-per2323455632',
    localConsolePort: Number(process.env.UNITY_LOCAL_CONSOLE_PORT || 4477),
  };
}

export function buildRepoPath(repoName: string): string {
  return path.join(WORKSPACE_DIR, repoName);
}

export function getProjectByName(repoName: string): WorkspaceProject {
  return {
    name: repoName,
    repoPath: buildRepoPath(repoName),
    workspaceDir: WORKSPACE_DIR,
  };
}

export function getDefaultProject(): WorkspaceProject {
  return getProjectByName(getRuntimeConfig().githubRepo);
}
