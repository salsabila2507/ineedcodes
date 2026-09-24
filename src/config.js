// config.js: load, validate, save provider config. Secrets never get printed here.
// Multiple providers can be saved; the active one is mirrored on the top-level
// fields (baseUrl/apiKey/model) so every other module keeps working unchanged.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CONFIG_DIR = process.env.INEED_CONFIG_DIR || path.join(os.homedir(), '.ineedcodes');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export { CONFIG_DIR as configDirPath };

const cleanUrl = u => String(u ?? '').replace(/\/+$/, '');

// step budget: 30 was too small for real builds, so it is configurable now
export const DEFAULT_MAX_STEPS = 100;

export function clampSteps(v) {
  if (v == null || typeof v === 'boolean' || (typeof v === 'string' && !v.trim())) return DEFAULT_MAX_STEPS;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(200, Math.max(5, n)) : DEFAULT_MAX_STEPS;
}

// resolve the providers map and the active name. A legacy flat config (baseUrl
// at top level) migrates into a "default" provider, and top-level fields act as
// overrides of the active provider so model/url changes keep working.
function resolveProviders(c) {
  const raw = (c.providers && typeof c.providers === 'object' && !Array.isArray(c.providers)) ? c.providers : {};
  const providers = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    providers[String(name)] = {
      baseUrl: cleanUrl(p.baseUrl),
      apiKey: String(p.apiKey ?? ''),
      model: String(p.model ?? '')
    };
  }
  let provider = String(c.provider ?? '');
  if (!Object.keys(providers).length && (c.baseUrl || c.model)) {
    providers.default = { baseUrl: cleanUrl(c.baseUrl), apiKey: String(c.apiKey ?? ''), model: String(c.model ?? '') };
    provider = provider || 'default';
  }
  if (!providers[provider]) provider = Object.keys(providers)[0] ?? '';
  if (provider) {
    const active = providers[provider];
    if (c.baseUrl !== undefined) active.baseUrl = cleanUrl(c.baseUrl);
    if (c.apiKey !== undefined) active.apiKey = String(c.apiKey ?? '');
    if (c.model !== undefined) active.model = String(c.model);
  }
  const active = provider ? providers[provider] : { baseUrl: '', apiKey: '', model: '' };
  return { providers, provider, baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model };
}

export function normalize(c) {
  const p = resolveProviders(c ?? {});
  return {
    providers: p.providers,
    provider: p.provider,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: p.model,
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
    maxSteps: clampSteps(c.maxSteps),
    maxWorkers: Math.min(8, Math.max(1, Math.floor(Number(c.maxWorkers)) || 4)),
    parallelReads: Math.min(8, Math.max(1, Math.floor(Number(c.parallelReads)) || 6)),
    models: (c.models && typeof c.models === 'object' && !Array.isArray(c.models))
      ? Object.fromEntries(Object.entries(c.models).map(([k, v]) => [k, String(v)]))
      : {},
    lastGood: String(c.lastGood ?? '')   // last model that completed a task without error
  };
}

export function loadConfig() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const cfg = normalize(raw ?? {});
  // env overrides win over the file: switch provider or run headless with no
  // config at all (INEED_BASE_URL / INEED_API_KEY / INEED_MODEL)
  if (process.env.INEED_BASE_URL) cfg.baseUrl = cleanUrl(process.env.INEED_BASE_URL);
  if (process.env.INEED_API_KEY) cfg.apiKey = String(process.env.INEED_API_KEY);
  if (process.env.INEED_MODEL) cfg.model = String(process.env.INEED_MODEL);
  if (process.env.INEED_MAX_STEPS != null) cfg.maxSteps = clampSteps(process.env.INEED_MAX_STEPS);
  if (!cfg.baseUrl || !cfg.model) return null;
  return cfg;
}

export function saveConfig(c) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const clean = normalize(c);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
  if (process.platform === 'win32') {
    // NTFS has no POSIX mode bits, so 0600 is a no-op there. Match the Linux
    // guarantee (only the owner can read the file with the API key) by
    // replacing the inherited ACL with a single full-control grant for the
    // current user. Best effort: a missing/blocked icacls must not fail a save.
    try {
      const user = process.env.USERNAME || process.env.USER || '';
      if (user) spawnSync('icacls', [CONFIG_FILE, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
    } catch {}
  }
  return clean;
}

// ── provider profiles ──
export function providerNames(cfg) {
  return Object.keys(cfg?.providers ?? {});
}

export function setActiveProvider(cfg, name) {
  const p = cfg?.providers?.[name];
  if (!p) return null;
  return saveConfig(normalize({ ...cfg, provider: name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }));
}

export function addProvider(cfg, name, profile) {
  const key = String(name ?? '').trim();
  if (!key) return null;
  const prof = {
    baseUrl: cleanUrl(profile?.baseUrl),
    apiKey: String(profile?.apiKey ?? ''),
    model: String(profile?.model ?? '')
  };
  if (!prof.baseUrl || !prof.model) return null;
  const providers = { ...(cfg?.providers ?? {}), [key]: prof };
  // adding a provider makes it active: that is the usual intent
  return saveConfig(normalize({ ...cfg, providers, provider: key, baseUrl: prof.baseUrl, apiKey: prof.apiKey, model: prof.model }));
}

export function removeProvider(cfg, name) {
  const providers = { ...(cfg?.providers ?? {}) };
  if (!providers[name]) return null;
  delete providers[name];
  const provider = cfg.provider === name ? (Object.keys(providers)[0] ?? '') : cfg.provider;
  const p = providers[provider] ?? { baseUrl: '', apiKey: '', model: '' };
  return saveConfig(normalize({ ...cfg, providers, provider, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }));
}

export function clearConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch {}
}
