// boost.js: isolated execution in a git worktree (master prompt #19-20).
// Work happens away from the user's tree; reconcile only after verification.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() };
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
  const r = git(['worktree', 'add', '-b', branch, dir], cwd);
  if (!r.ok) return { ok: false, error: r.out };
  return { ok: true, dir, branch };
}

export function commitBoost(dir, message) {
  git(['add', '-A'], dir);
  const r = git(['commit', '-m', message, '--allow-empty'], dir);
  return r.ok;
}

export function boostDiff(dir) {
  const stat = git(['diff', 'HEAD~1', '--stat'], dir);
  const files = git(['diff', 'HEAD~1', '--name-only'], dir);
  return { stat: stat.out, files: files.out.split('\n').filter(Boolean) };
}

export function mergeBoost(cwd, branch) {
  return git(['merge', '--no-edit', branch], cwd);
}

export function cleanupBoost(cwd, dir, branch) {
  git(['worktree', 'remove', '--force', dir], cwd);
  git(['branch', '-D', branch], cwd);
}
