/**
 * Sync Module
 *
 * Provides synchronization functionality for keeping the code graph
 * up-to-date with file system changes.
 *
 * Components:
 * - FileWatcher: Debounced fs.watch that auto-triggers sync on file changes
 * - Watch policy: decides when the watcher must be disabled (e.g. WSL2 /mnt)
 * - Git sync hooks: removal of the commit/merge/checkout hooks earlier
 *   versions installed (none are installed any more)
 * - Git worktree awareness: detect when a query borrows another tree's index
 * - Content hashing for change detection (in extraction module)
 * - Incremental reindexing (in extraction module)
 */

export { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './watcher';
export { watchDisabledReason, detectWsl } from './watch-policy';
export {
  removeGitSyncHook,
  isGitRepo,
  LEGACY_SYNC_HOOKS,
  type GitHookName,
  type GitHookRemoval,
} from './git-hooks';
export {
  gitWorktreeRoot,
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from './worktree';
