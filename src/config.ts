import path from 'path';
import 'dotenv/config';

// Base workspace where Jarvis clones/creates all target repositories.
export const WORKSPACE_DIR: string = path.resolve('./workspaces');
// Mutable pointer to the currently active repository inside WORKSPACE_DIR.
export let TARGET_REPO_PATH: string = path.join(WORKSPACE_DIR, process.env.GITHUB_REPO as string);

// Switches the active repository context used by all runtime modules.
export function setActiveProject(repoName: string) {
    TARGET_REPO_PATH = path.join(WORKSPACE_DIR, repoName);
    process.env.GITHUB_REPO = repoName;
}
