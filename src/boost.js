// boost.js: isolated execution in a git worktree (master prompt #19-20).
// Work happens away from the user's tree; reconcile only after verification.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import { quietGitEnv, stripCrlfWarnings } from './tools.js';

function git(args, cwd) {
  // bounded and non-interactive: a hook, a pager or a lock must not hang a boost
  const r = spawnSync('git', ['-c', 'core.safecrlf=false', ...args], {
    cwd, encoding: 'utf8', timeout: 60_000,
    env: { ...quietGitEnv(), GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
  });
  const out = stripCrlfWarnings((r.stdout ?? '') + (r.stderr ?? '')).trim();
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, out: 'git timed out after 60s' };
  if (r.error) return { ok: false, out: 'git failed: ' + r.error.message };
  return { ok: r.status === 0, out };
}

export function boostAvailable(cwd) {
  const inside = git(['rev-parse', '--is-inside-work-tree'], cwd);
  return inside.ok && inside.out === 'true';
}

export function currentBranch(cwd) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).out;
}

export function startBoost(cwd) {
  // pid + clock: two boosts in the same millisecond must not collide
  const n = (Date.now() % 1_000_000) * 10 + (process.pid % 10);
  const dir = path.join(os.tmpdir(), 'ineed-boost-' + n);
  const branch = 'ineed-boost-' + n;
  const base = git(['rev-parse', 'HEAD'], cwd);
  if (!base.ok) return { ok: false, error: base.out };
  const r = git(['worktree', 'add', '-b', branch, dir, base.out], cwd);
  if (!r.ok) return { ok: false, error: r.out };
  return { ok: true, dir, branch, base: base.out };
}

export function commitBoost(dir, message) {
  const add = git(['add', '-A'], dir);
  if (!add.ok) return { ok: false, error: add.out };
  // no empty commit: if the task changed nothing, there is nothing to reconcile
  const pending = git(['diff', '--cached', '--name-only'], dir);
  if (!pending.out) return { ok: true, empty: true };
  const r = git(['commit', '-m', message], dir);
  return { ok: r.ok, error: r.out };
}

export function boostDiff(dir, base) {
  const stat = git(['diff', base, 'HEAD', '--stat'], dir);
  const files = git(['diff', base, 'HEAD', '--name-only'], dir);
  if (!stat.ok || !files.ok) return { ok: false, error: files.ok ? stat.out : files.out, stat: '', files: [] };
  return { ok: true, stat: stat.out, files: files.out.split('\n').filter(Boolean) };
}

export function mergeBoost(cwd, branch) {
  return git(['merge', '--no-edit', branch], cwd);
}

export function cleanupBoost(cwd, dir, branch) {
  git(['worktree', 'remove', '--force', dir], cwd);
  git(['branch', '-D', branch], cwd);
}
