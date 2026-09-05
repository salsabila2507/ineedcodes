// sessions.js: session persistence. Conversation checkpoints live outside the repo,
// under the config dir, so users can leave and resume work (master prompt #34).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR as configDirPath } from './config.js';
const DIR = path.join(configDirPath, 'sessions');


export function saveSession(data) {
  fs.mkdirSync(DIR, { recursive: true });
  const id = data.id || 's_' + Date.now();
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify({ ...data, id, time: Date.now() }, null, 2), { mode: 0o600 });
  return id;
}

export function listSessions() {
  try {
    return fs.readdirSync(DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time)
      .slice(0, 20);
  } catch { return []; }
}

export function loadSession(id) {
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DIR, id + '.json'), 'utf8')); } catch { return null; }
}
