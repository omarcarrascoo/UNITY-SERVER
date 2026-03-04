import path from 'path';
import 'dotenv/config';

export const WORKSPACE_DIR: string = path.resolve('./workspaces');
export const TARGET_REPO_PATH: string = path.join(WORKSPACE_DIR, process.env.GITHUB_REPO as string);