/**
 * Git Sync Hooks (removal only)
 *
 * Earlier versions could install git hooks (post-commit, post-merge,
 * post-checkout) that ran `codegraph sync` when the live file watcher was
 * off. This copy never installs git hooks: it doesn't write into anyone's
 * hooks directory, whether the repository's or one set for a session (an
 * agent's guard hooks, say). Keep the index fresh with `codegraph sync`, the
 * watcher, or the tool driving CodeGraph (rene syncs before each query).
 *
 * What remains removes the hooks an earlier version installed: only the
 * block between our marker comments, keeping any user-authored hook content.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const MARKER_BEGIN = '# >>> codegraph sync hook >>>';
const MARKER_END = '# <<< codegraph sync hook <<<';

export type GitHookName = 'post-commit' | 'post-merge' | 'post-checkout';

/** The hooks earlier versions installed: commit, merge (git pull), checkout. */
export const LEGACY_SYNC_HOOKS: GitHookName[] = ['post-commit', 'post-merge', 'post-checkout'];

export interface GitHookRemoval {
  /** Hook names our block was removed from. */
  removed: GitHookName[];
  /** Resolved hooks directory, or null when not a git repo. */
  hooksDir: string | null;
  /** Reason nothing happened (e.g. not a git repository). */
  skipped?: string;
}

/**
 * Whether `projectRoot` is inside a git working tree. Returns false if git
 * isn't installed or the path isn't a repo.
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000, // fail fast instead of hanging init/sync on a stuck git (#1139)
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/** The scope of `core.hooksPath` (`command`, `local`, ...), or null when unset. */
function hooksPathScope(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--show-scope', '--get', 'core.hooksPath'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    return out.split('\t')[0] || null;
  } catch {
    return null; // unset (git exits 1) or git unavailable
  }
}

/**
 * Resolve the git hooks directory for a project, honoring `core.hooksPath`
 * and git worktrees. Returns an absolute path, or null when not a repo.
 */
function gitHooksDir(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000, // same rationale as isGitRepo
    }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(projectRoot, out);
  } catch {
    return null;
  }
}

/** Remove our marker block (and the marker lines) from hook content. */
function stripMarkerBlock(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === MARKER_BEGIN) { inBlock = true; continue; }
    if (trimmed === MARKER_END) { inBlock = false; continue; }
    if (!inBlock) kept.push(line);
  }
  return kept.join('\n');
}

/** Whether a hook body is just a shebang / blank lines (i.e. only ever ours). */
function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'));
}

function chmodExecutable(file: string): void {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* chmod is a no-op / unsupported on some platforms (e.g. Windows) */
  }
}

/**
 * Remove the sync hooks an earlier version installed. Strips only our marker
 * block; deletes the hook file entirely when nothing but a shebang remains,
 * otherwise rewrites the user's content untouched. A hooks directory set for
 * the session (`core.hooksPath` from `git -c` or GIT_CONFIG_* in the
 * environment) isn't the repository's, so it is left alone.
 */
export function removeGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = LEGACY_SYNC_HOOKS,
): GitHookRemoval {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { removed: [], hooksDir: null, skipped: 'not a git repository' };
  }
  if (hooksPathScope(projectRoot) === 'command') {
    return {
      removed: [],
      hooksDir,
      skipped: 'core.hooksPath is set for this session (git -c or GIT_CONFIG_* in the environment), not by the repository',
    };
  }

  const removed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;

    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(MARKER_BEGIN)) continue;

    const stripped = stripMarkerBlock(original);
    if (isEffectivelyEmpty(stripped)) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, `${stripped.replace(/\s*$/, '')}\n`);
      chmodExecutable(file);
    }
    removed.push(hook);
  }

  return { removed, hooksDir };
}
