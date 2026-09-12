// skillssync.js: download the gated security skills from the source repository
// into ~/.ineedcodes/skills. The npm package ships a clean core (registry policy
// blocks the bundled content), so skills are an explicit opt-in download.
// Override the source with INEED_SKILLS_REPO (used by tests and forks).

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR } from './config.js';

const DEFAULT_REPO = 'https://github.com/salsabila2507/ineedcodes.git';

export function skillsSync(opts = {}) {
  const repo = opts.repo || process.env.INEED_SKILLS_REPO || DEFAULT_REPO;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ineed-skills-'));
  try {
    const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', repo, tmp], { encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) return { ok: false, error: ((r.stderr ?? '') || 'git clone failed').trim().slice(0, 300) };
    const src = path.join(tmp, 'skills');
    let entries;
    try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return { ok: false, error: 'the repository has no skills/ folder' }; }
    const dest = path.join(CONFIG_DIR, 'skills');
    fs.mkdirSync(dest, { recursive: true });
    let copied = 0;
    for (const e of entries) {
      if (!e.isDirectory() || !fs.existsSync(path.join(src, e.name, 'SKILL.md'))) continue;
      fs.cpSync(path.join(src, e.name), path.join(dest, e.name), { recursive: true });
      copied++;
    }
    return { ok: true, copied, dest };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
