// config.js: load, validate, save provider config. Secrets never get printed here.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CONFIG_DIR = process.env.INEED_CONFIG_DIR || path.join(os.homedir(), '.ineedcodes');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export { CONFIG_DIR as configDirPath };

export function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c && typeof c.baseUrl === 'string' && typeof c.apiKey === 'string' && typeof c.model === 'string'
      && c.baseUrl && c.model) return normalize(c);
  } catch {}
  return null;
}

export function normalize(c) {
  return {
    baseUrl: String(c.baseUrl).replace(/\/+$/, ''),
    apiKey: String(c.apiKey ?? ''),
    model: String(c.model),
    reasoning: c.reasoning === 'high' ? 'high' : 'low',
    mode: c.mode === 'plan' ? 'plan' : 'build',
    memory: c.memory !== false,
    mcp: c.mcp !== false,
    humanize: c.humanize !== false,
    permEdit: c.permEdit === 'allow' ? 'allow' : 'ask',
    permShell: c.permShell === 'allow' ? 'allow' : 'ask'
  };
}

export function saveConfig(c) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const clean = normalize(c);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  return clean;
}

export function clearConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
}
