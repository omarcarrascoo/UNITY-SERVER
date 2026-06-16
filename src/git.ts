import fs from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import util from 'util';
import { getRuntimeConfig } from './config.js';
import type { PreparedWorkspace, WorkspaceProject } from './domain/runtime.js';
import { initFullstackProject } from './templates.js';

const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

interface WorkspaceTargets {
  expoPath: string;
  apiPath: string | null;
  packageDirs: string[];
}

function pathExistsNoFollow(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hasValidNodeModules(packageDir: string): boolean {
  const nodeModulesPath = path.join(packageDir, 'node_modules');

  try {
    const stat = fs.lstatSync(nodeModulesPath);

    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(nodeModulesPath);
      return fs.statSync(resolved).isDirectory();
    }

    return stat.isDirectory();
  } catch {
    return false;
  }
}

function removeInvalidNodeModulesIfNeeded(packageDir: string): void {
  const nodeModulesPath = path.join(packageDir, 'node_modules');

  if (!pathExistsNoFollow(nodeModulesPath)) {
    return;
  }

  if (!hasValidNodeModules(packageDir)) {
    fs.rmSync(nodeModulesPath, { recursive: true, force: true });
  }
}

function getBaseBranch(): string {
  return getRuntimeConfig().githubBaseBranch;
}

function getRepoUrl(project: WorkspaceProject): string {
  const config = getRuntimeConfig();
  return `https://github.com/${config.githubOwner}/${project.name}.git`;
}

function scanWorkspaceTargets(basePath: string): WorkspaceTargets {
  let expoPath = basePath;
  let apiPath: string | null = null;
  const packageDirs: string[] = [];

  if (fs.existsSync(path.join(basePath, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(basePath, 'package.json'), 'utf8'));

    if (pkg.dependencies?.expo || pkg.devDependencies?.expo) {
      return {
        expoPath: basePath,
        apiPath: null,
        packageDirs: [basePath],
      };
    }
  }

  const items = fs.readdirSync(basePath, { withFileTypes: true });

  for (const item of items) {
    if (!item.isDirectory() || ['node_modules', '.git', 'assets', 'dist'].includes(item.name)) {
      continue;
    }

    const subDir = path.join(basePath, item.name);
    const packageJsonPath = path.join(subDir, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    packageDirs.push(subDir);

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    if (pkg.dependencies?.expo || pkg.devDependencies?.expo || item.name.startsWith('expo-')) {
      expoPath = subDir;
    }

    if (pkg.dependencies?.['@nestjs/core'] || item.name.includes('api') || item.name.includes('infra')) {
      apiPath = subDir;
    }
  }

  return {
    expoPath,
    apiPath,
    packageDirs,
  };
}

async function installWorkspaceDependencies(basePath: string, targets: WorkspaceTargets): Promise<void> {
  if (targets.packageDirs.length === 0 && fs.existsSync(path.join(basePath, 'package.json'))) {
    removeInvalidNodeModulesIfNeeded(basePath);
    console.log(`⚙️ Single Repo detected. Installing Root Dependencies...`);
    await execPromise(`npm install`, { cwd: basePath });
    return;
  }

  console.log(`⚙️ Monorepo detected. Scanning modules...`);

  for (const packageDir of targets.packageDirs) {
    removeInvalidNodeModulesIfNeeded(packageDir);
    console.log(`⚙️ Installing module: ${path.basename(packageDir)}...`);
    await execPromise(`npm install`, { cwd: packageDir });
  }
}

/**
 * Reinstall dependencies in an already-prepared workspace's package dirs.
 *
 * Used before the final runtime gate when a task added/changed a dependency:
 * task worktrees symlink the base node_modules, so a newly-added package never
 * reaches the base unless we reinstall here. Cheap to call; npm is a no-op when
 * nothing changed. Failures are logged, not thrown (the gate will surface them).
 */
export async function refreshWorkspaceDependencies(
  workspace: PreparedWorkspace,
  onLog?: (message: string) => void,
): Promise<void> {
  const dirs = workspace.packageDirs.length ? workspace.packageDirs : [workspace.repoPath];
  for (const packageDir of dirs) {
    if (!fs.existsSync(path.join(packageDir, 'package.json'))) continue;
    removeInvalidNodeModulesIfNeeded(packageDir);
    onLog?.(`📦 Refreshing dependencies in ${path.basename(packageDir)}...`);
    try {
      await execPromise('npm install', { cwd: packageDir, timeout: 300_000 });
    } catch (err) {
      onLog?.(`⚠️ Dependency refresh failed in ${packageDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function resolveWorkspace(project: WorkspaceProject): Promise<PreparedWorkspace> {
  if (!fs.existsSync(project.repoPath)) {
    throw new Error(`Workspace for project "${project.name}" does not exist locally.`);
  }

  const targets = scanWorkspaceTargets(project.repoPath);

  return {
    ...project,
    expoPath: targets.expoPath,
    apiPath: targets.apiPath,
    packageDirs: targets.packageDirs,
  };
}

export async function prepareWorkspace(project: WorkspaceProject): Promise<PreparedWorkspace> {
  if (!fs.existsSync(project.workspaceDir)) {
    fs.mkdirSync(project.workspaceDir, { recursive: true });
  }

  if (!fs.existsSync(project.repoPath)) {
    console.log(`📥 Cloning ${project.name}...`);
    await execFilePromise('git', ['clone', getRepoUrl(project), project.repoPath]);
  } else {
    console.log(`🔄 Resetting and updating ${project.name} for a fresh start...`);
    await resetWorkspace(project);
    await execFilePromise('git', ['remote', 'set-url', 'origin', getRepoUrl(project)], { cwd: project.repoPath }).catch(() => {});
    await execFilePromise('git', ['checkout', getBaseBranch()], { cwd: project.repoPath });
    await execFilePromise('git', ['pull', 'origin', getBaseBranch()], { cwd: project.repoPath });
  }

  const targets = scanWorkspaceTargets(project.repoPath);
  await installWorkspaceDependencies(project.repoPath, targets);

  return {
    ...project,
    expoPath: targets.expoPath,
    apiPath: targets.apiPath,
    packageDirs: targets.packageDirs,
  };
}

export async function getRepositoryStatus(project: WorkspaceProject): Promise<string> {
  try {
    const { stdout } = await execFilePromise('git', ['status', '--porcelain'], { cwd: project.repoPath });
    return stdout || '';
  } catch {
    return '';
  }
}

export async function getRepositoryDiff(project: WorkspaceProject): Promise<string> {
  try {
    const { stdout } = await execFilePromise('git', ['diff'], { cwd: project.repoPath });
    return stdout || '';
  } catch {
    return '';
  }
}

export async function resetWorkspace(project: WorkspaceProject): Promise<void> {
  await execFilePromise('git', ['reset', '--hard', 'HEAD'], { cwd: project.repoPath }).catch(() => {});
  await execFilePromise('git', ['clean', '-fd'], { cwd: project.repoPath }).catch(() => {});
}

export async function createPullRequest(
  workspace: PreparedWorkspace,
  featureName: string,
  commitMessage: string,
): Promise<string> {
  const branchName = `jarvis-${featureName}`;
  const config = getRuntimeConfig();

  try {
    await execFilePromise('git', ['remote', 'set-url', 'origin', getRepoUrl(workspace)], { cwd: workspace.repoPath }).catch(() => {});
    await execFilePromise('git', ['checkout', '-b', branchName], { cwd: workspace.repoPath });
    await execFilePromise('git', ['add', '.'], { cwd: workspace.repoPath });
    await execFilePromise('git', ['commit', '-m', commitMessage], { cwd: workspace.repoPath });
    await execFilePromise('git', ['push', 'origin', branchName], { cwd: workspace.repoPath });

    const prResponse = await fetch(
      `https://api.github.com/repos/${config.githubOwner}/${workspace.name}/pulls`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `✨ ${commitMessage}`,
          body: `This PR was automatically generated via Discord.\n\n**Exact Changes:**\n${commitMessage}`,
          head: branchName,
          base: getBaseBranch(),
        }),
      },
    );

    if (!prResponse.ok) throw new Error(await prResponse.text());

    const prData = await prResponse.json();
    await execFilePromise('git', ['checkout', getBaseBranch()], { cwd: workspace.repoPath });
    return prData.html_url;
  } catch (error) {
    await execFilePromise('git', ['checkout', getBaseBranch()], { cwd: workspace.repoPath }).catch(() => {});
    throw error;
  }
}

/**
 * Open a PR from an ALREADY-PUSHED branch (the autonomous-run case) toward the
 * base branch. Unlike `createPullRequest`, this does not commit/push — an
 * autonomous run already commits + pushes to its integration branch during
 * execution. This just ensures the branch is on the remote and opens the PR.
 *
 * Returns the PR URL, or the existing PR URL if one is already open for the head.
 */
export async function createPullRequestFromBranch(
  repoName: string,
  repoPath: string,
  branchName: string,
  title: string,
  body: string,
): Promise<string> {
  const config = getRuntimeConfig();
  const base = getBaseBranch();

  // Make sure the branch is on the remote (no-op if already pushed).
  await execFilePromise('git', ['push', '-u', 'origin', branchName], { cwd: repoPath }).catch(() => {});

  const apiBase = `https://api.github.com/repos/${config.githubOwner}/${repoName}`;
  const headers = {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  const prResponse = await fetch(`${apiBase}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, body, head: branchName, base }),
  });

  if (prResponse.ok) {
    return (await prResponse.json()).html_url as string;
  }

  // A PR for this head may already exist — return it instead of failing.
  const errText = await prResponse.text();
  if (/pull request already exists/i.test(errText)) {
    const existing = await fetch(
      `${apiBase}/pulls?head=${config.githubOwner}:${branchName}&state=open`,
      { headers },
    );
    if (existing.ok) {
      const list = (await existing.json()) as Array<{ html_url: string }>;
      if (list.length) return list[0].html_url;
    }
  }

  throw new Error(`Failed to open PR: ${errText}`);
}

export async function scaffoldProject(type: string, name: string, workspaceDir: string): Promise<void> {
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  if (type === 'expo') {
    await execFilePromise('npx', ['create-expo-app', name, '--template', 'blank-typescript'], { cwd: workspaceDir });
    return;
  }

  if (type === 'nest') {
    await execFilePromise('npx', ['@nestjs/cli', 'new', name, '--package-manager', 'npm', '--skip-git'], { cwd: workspaceDir });
    return;
  }

  if (type === 'fullstack') {
    await initFullstackProject(name, workspaceDir);
    return;
  }

  throw new Error(`Unsupported scaffold type: ${type}`);
}
