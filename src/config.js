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
    tui: c.tui === true ? true : c.tui === false ? false : null,
    theme: ['light', 'mono', 'nord', 'dracula', 'synthwave'].includes(c.theme) ? c.theme : 'dark',
    humanize: c.humanize !== false,
    stream: c.stream === true,
    searchUrl: c.searchUrl ? String(c.searchUrl) : '',
    explain: ['short', 'deep'].includes(c.explain) ? c.explain : 'normal',
    permEdit: c.permEdit === 'allow' ? 'allow' : 'ask',
    permShell: c.permShell === 'allow' ? 'allow' : 'ask',
    permNet: c.permNet === 'ask' ? 'ask' : 'allow',
    models: (c.models && typeof c.models === 'object' && !Array.isArray(c.models))
      ? Object.fromEntries(Object.entries(c.models).map(([k, v]) => [k, String(v)]))
      : {},
    lastGood: String(c.lastGood ?? '')   // last model that completed a task without error
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
