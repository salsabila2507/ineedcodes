// switch.js: provider switch that pulls the live model list instead of trusting
// a saved id. A saved model can be gone from a provider's catalog at any time,
// and that used to surface as an opaque "model not found" on the next task.

import { fetchModels } from './provider.js';
import { normalize, saveConfig } from './config.js';

// beginner default: a plain general chat model that can also use tools. Ordered
// by how well they usually behave for coding work, then anything else.
const PREFERRED = [
  /gpt-4o(?!-audio)/i, /gpt-4\.1/i, /gpt-5/i, /claude-(sonnet|opus)/i, /gemini-(1\.5|2)/i,
  /glm-?4/i, /glm-?5/i, /deepseek/i, /qwen/i, /llama-?3/i, /mistral/i, /flash/i
];

export function suggestModel(models, current) {
  const list = models.filter(Boolean);
  if (!list.length) return '';
  if (current && list.includes(current)) return current;
  for (const re of PREFERRED) {
    const hit = list.find(m => re.test(m) && !/embed|whisper|tts|image|vision|audio|rerank|moderation/i.test(m));
    if (hit) return hit;
  }
  return list[0];
}

// switch to a saved provider and make sure the active model actually exists
// there. Returns the new config plus what happened, so callers can explain it.
export async function switchProviderLive(cfg, name, { signal, save = true } = {}) {
  const prof = cfg?.providers?.[name];
  if (!prof) return { ok: false, error: `No provider named ${name}.` };
  const base = normalize({ ...cfg, provider: name, baseUrl: prof.baseUrl, apiKey: prof.apiKey, model: prof.model });
  let models = [];
  let fetchError = '';
  try {
    models = await fetchModels(base, signal);
  } catch (err) {
    if (err?.stopped) throw err;
    fetchError = String(err.message ?? err);
  }
  const wanted = prof.model;
  const picked = suggestModel(models, wanted);
  const model = picked || wanted;          // no list: keep the saved id, the task will report the real error
  const next = normalize({ ...base, model });
  if (save && model !== wanted) {
    next.providers = { ...next.providers, [name]: { ...next.providers[name], model } };
  }
  if (save) { try { saveConfig(next); } catch {} }
  return {
    ok: true,
    cfg: next,
    models,
    fetchError,
    model,
    modelChanged: Boolean(model && model !== wanted),
    modelWasEmpty: !wanted
  };
}
