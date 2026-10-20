/**
 * Git Sync Hooks Tests
 *
 * CodeGraph no longer installs git hooks; it only removes the ones earlier
 * versions installed (`codegraph uninit`). Exercises real git repos in temp
 * dirs — no mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { removeGitSyncHook, isGitRepo, LEGACY_SYNC_HOOKS } from '../src/sync/git-hooks';
import * as gitHooks from '../src/sync/git-hooks';

/** The block earlier versions wrote into each hook. */
const LEGACY_BLOCK = [
  '# >>> codegraph sync hook >>>',
  '# Keeps the CodeGraph index fresh while the live file watcher is off',
  'if command -v codegraph >/dev/null 2>&1; then',
  '  ( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1',
  'fi',
  '# <<< codegraph sync hook <<<',
].join('\n');

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

/** Write a hook as an earlier version left it, optionally after user content. */
function writeLegacyHook(hooksDir: string, hook: string, userContent?: string): string {
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, hook);
  fs.writeFileSync(
    file,
    userContent ? `${userContent}\n\n${LEGACY_BLOCK}\n` : `#!/bin/sh\n${LEGACY_BLOCK}\n`,
  );
  return file;
}

describe('git sync hooks', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-githooks-'));
  });

  afterEach(() => {
    if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('offers no way to install hooks', () => {
    expect(Object.keys(gitHooks).sort()).toEqual(
      ['LEGACY_SYNC_HOOKS', 'isGitRepo', 'removeGitSyncHook'].sort(),
    );
  });

  it('removes hooks that were only ours', () => {
    gitInit(repo);
    const hooksDir = path.join(repo, '.git', 'hooks');
    const files = LEGACY_SYNC_HOOKS.map((hook) => writeLegacyHook(hooksDir, hook));

    const result = removeGitSyncHook(repo);
    expect(result.removed.sort()).toEqual([...LEGACY_SYNC_HOOKS].sort());
    for (const file of files) expect(fs.existsSync(file)).toBe(false);
  });

  it('keeps user content when the hook is shared', () => {
    gitInit(repo);
    const file = writeLegacyHook(
      path.join(repo, '.git', 'hooks'),
      'post-commit',
      '#!/bin/sh\necho "keep me"',
    );

    removeGitSyncHook(repo, ['post-commit']);

    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('echo "keep me"');
    expect(body).not.toContain('codegraph sync');
  });

  it('leaves hooks without our block alone', () => {
    gitInit(repo);
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const file = path.join(hooksDir, 'post-commit');
    fs.writeFileSync(file, '#!/bin/sh\necho mine\n');

    expect(removeGitSyncHook(repo).removed).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('honors a core.hooksPath the repository sets', () => {
    gitInit(repo);
    execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo, stdio: 'ignore' });
    const file = writeLegacyHook(path.join(repo, '.husky'), 'post-commit');

    const result = removeGitSyncHook(repo, ['post-commit']);
    expect(result.hooksDir).toBe(path.join(repo, '.husky'));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never touches a hooks directory set for the session', () => {
    gitInit(repo);
    const sessionHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-session-hooks-'));
    const guard = writeLegacyHook(sessionHooks, 'post-commit', '#!/bin/sh\nexit 0');
    const before = fs.readFileSync(guard, 'utf8');
    const saved = { ...process.env };
    // How a session (an agent's guard hooks, say) points every git it starts
    // at its own hooks; it wins over the repository's own settings.
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = sessionHooks;
    try {
      const result = removeGitSyncHook(repo);
      expect(result.removed).toEqual([]);
      expect(result.skipped).toMatch(/set for this session/);
      expect(fs.readFileSync(guard, 'utf8')).toBe(before);
    } finally {
      process.env = saved;
      fs.rmSync(sessionHooks, { recursive: true, force: true });
    }
  });

  it('skips cleanly when not a git repository', () => {
    expect(isGitRepo(repo)).toBe(false);
    const result = removeGitSyncHook(repo);
    expect(result.removed).toEqual([]);
    expect(result.hooksDir).toBeNull();
    expect(result.skipped).toMatch(/not a git repository/);
  });
});
