import path from 'path';
import 'dotenv/config';

import { fileURLToPath } from 'url';
import 'dotenv/config';





const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const WORKSPACE_DIR: string = path.resolve(__dirname, '../workspaces');
// Mutable pointer to the currently active repository inside WORKSPACE_DIR.
export let TARGET_REPO_PATH: string = path.join(WORKSPACE_DIR, process.env.GITHUB_REPO as string);

// Switches the active repository context used by all runtime modules.
export function setActiveProject(repoName: string) {
    TARGET_REPO_PATH = path.join(WORKSPACE_DIR, repoName);
    process.env.GITHUB_REPO = repoName;
}
