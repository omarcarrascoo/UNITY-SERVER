import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import type { WorkspaceProject } from './domain/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const WORKSPACE_DIR = path.resolve(PROJECT_ROOT, 'workspaces');

export interface RuntimeConfig {
  workspaceDir: string;
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  githubBaseBranch: string;
  discordToken: string;
  discordClientId: string;
  figmaToken?: string;
  deepseekApiKey?: string;
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
    githubOwner: getRequiredEnv('GITHUB_OWNER'),
    githubRepo: getRequiredEnv('GITHUB_REPO'),
    githubToken: getRequiredEnv('GITHUB_TOKEN'),
    githubBaseBranch: process.env.GITHUB_BASE_BRANCH || 'main',
    discordToken: getRequiredEnv('DISCORD_TOKEN'),
    discordClientId: getRequiredEnv('DISCORD_CLIENT_ID'),
    figmaToken: process.env.FIGMA_TOKEN,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
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
