// sessions.js: session persistence. Conversation checkpoints live outside the repo,
// under the config dir, so users can leave and resume work (master prompt #34).
// IDs are HHMM-DDMM codes so /resume 1425-0609 just works.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR as configDirPath } from './config.js';

const DIR = path.join(configDirPath, 'sessions');

const pad = n => String(n).padStart(2, '0');

export function newSessionId(d = new Date()) {
  return `${pad(d.getHours())}${pad(d.getMinutes())}-${pad(d.getDate())}${pad(d.getMonth() + 1)}`;
}

export function saveSession(data) {
  fs.mkdirSync(DIR, { recursive: true });
  let id = data.id || newSessionId();
  if (!data.id) {
    // two sessions started in the same minute must not overwrite each other:
    // the later one gets a -2, -3, ... suffix
    const base = id;
    for (let n = 2; fs.existsSync(path.join(DIR, id + '.json')) && n < 100; n++) {
      id = `${base}-${n}`;
    }
  }
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify({ ...data, id, time: Date.now() }, null, 2), { mode: 0o600 });
  return id;
}

export function listSessions() {
  try {
    return fs.readdirSync(DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean).filter(s => (s.history?.length ?? 0) > 0)
      .sort((a, b) => b.time - a.time)
      .slice(0, 20);
  } catch { return []; }
}

export function loadSession(id) {
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')); } catch { return null; }
}
