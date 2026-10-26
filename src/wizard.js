// wizard.js: first open. Bring-your-own-key: pick a normal provider (or paste any
// OpenAI-compatible base URL), enter your key, then choose a real model. Saved once.

import { fetchModels, chat } from './provider.js';
import { saveConfig } from './config.js';
import { aliasFor } from './builtin.js';
import { bold, dim, red, yellow, green, trunc, logo, BANNER, startSpinner } from './ui.js';
import { canPickInteractive, pickInteractive, takeKeys } from './picker.js';

// Common OpenAI-compatible providers offered on first open. You bring the key.
// Any other endpoint works too: paste a full base URL at the prompt.
const PROVIDERS = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { name: 'Ollama (local, no key needed)', baseUrl: 'http://localhost:11434/v1' }
];

export async function testConnection(cfg, signal) {
  // proves reachability + auth + a working chat in one shot. Tiny on purpose:
  // a few reply tokens, no streaming, no backoff retries, so a slow or dead
  // provider fails fast instead of hanging the setup
  const m = await chat({ ...cfg, stream: false, reasoning: 'low' }, [{ role: 'user', content: 'Reply with exactly: OK' }], undefined, signal, undefined, undefined, { maxTokens: 16, attempts: 1 });
  return String(m.content ?? '').trim();
}

// the setup test gets a hard deadline; INEED_TEST_TIMEOUT_MS overrides it (tests)
export const TEST_TIMEOUT_MS = 20_000;
const testTimeoutMs = () => Number(process.env.INEED_TEST_TIMEOUT_MS) || TEST_TIMEOUT_MS;

// run the test with a deadline, live elapsed seconds, and (on a terminal) a
// key to skip it: s or Ctrl+C. Resolves { ok, reply, secs } | { timeout } |
// { skipped } | { error }.
export async function timedTest(cfg, { timeoutMs = testTimeoutMs(), interactive = canPickInteractive() } = {}) {
  const ctrl = new AbortController();
  let why = '';
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  const timer = setTimeout(() => { why = 'timeout'; ctrl.abort('timeout'); }, timeoutMs);
  const label = () => `   testing ${cfg.model}... ${secs()}s` + (interactive ? '  (press s to skip and save anyway)' : '');
  let tick = null;
  if (process.stdout.isTTY) {
    process.stdout.write('\r' + label());
    tick = setInterval(() => process.stdout.write('\r' + label()), 500);
  }
  const restoreKeys = interactive
    ? takeKeys((str, key) => {
        if ((key.ctrl && key.name === 'c') || str === 's' || str === 'S') { why = 'skip'; ctrl.abort('skip'); }
      })
    : null;
  try {
    const reply = await testConnection(cfg, ctrl.signal);
    if (why) return why === 'skip' ? { skipped: true } : { timeout: true, secs: secs() };
    return { ok: true, reply, secs: secs() };
  } catch (error) {
    if (why === 'timeout') return { timeout: true, secs: secs() };
    if (why === 'skip') return { skipped: true };
    return { error };
  } finally {
    clearTimeout(timer);
    if (tick) clearInterval(tick);
    if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(Math.min(200, label().length + 2)) + '\r');
    restoreKeys?.();
  }
}

// arrow-key model list on a terminal. Returns the id, '' to fall back to the
// typed prompt (Esc), and throws the usual "aborted" error on Ctrl+C.
async function pickModelInteractive(models, initialId) {
  const r = await pickInteractive(models, { title: 'Model', initial: Math.max(0, models.indexOf(initialId)) });
  if (r.cancelled) throw Object.assign(new Error('Setup aborted.'), { aborted: true });
  return r.value ? String(r.value) : '';
}

export async function wizard(ask, { fromCommand = false, save = true } = {}) {
  const inputEnded = () => process.stdin.readableEnded === true && !process.stdout.isTTY;
  const abortIfEnded = () => { if (inputEnded()) throw Object.assign(new Error('Setup aborted: input ended.'), { aborted: true }); };

  console.log('');
  console.log(logo());
  console.log('');
  console.log(BANNER());
  console.log(bold('Welcome!') + dim(' Let\'s connect you to an AI provider. You only do this once.'));
  console.log(dim('Bring your own key. Any OpenAI-compatible API works: OpenAI, OpenRouter, Groq, Ollama, LM Studio, vLLM, and more.'));
  console.log('');

  // beginners sometimes type session commands (/provider, /model...) into
  // these prompts. Accepting them once saved "/provider" as a literal model id
  // and broke every later task. Say clearly what to do instead.
  const rejectCommand = v => {
    if (!v.startsWith('/')) return true;
    console.log(red('   "' + v + '" is a command for inside a session, not an answer here.'));
    console.log(dim('   Just type the value directly (or press Enter for the suggestion).'));
    return false;
  };

  // step 1: choose a provider by number, or paste any OpenAI-compatible base URL.
  // Enter defaults to the first provider (OpenAI). The built-in ineed.codes
  // gateway is intentionally NOT offered here: it needs an admin-issued key.
  let baseUrl = '';
  console.log(bold('1. Pick a provider') + dim(' (type a number, or paste any OpenAI-compatible base URL):'));
  PROVIDERS.forEach((p, i) => console.log('   ' + (i + 1) + ') ' + p.name + dim('  ' + p.baseUrl)));
  console.log('   ' + (PROVIDERS.length + 1) + ') ' + 'Other' + dim('  (paste a base URL, e.g. http://localhost:1234/v1)'));
  while (true) {
    const ans = (await ask(`   Choice (Enter = 1, ${PROVIDERS[0].name}): `)).trim();
    if (ans === '') { baseUrl = PROVIDERS[0].baseUrl; break; }
    if (!rejectCommand(ans)) continue;
    if (/^https?:\/\//.test(ans)) { baseUrl = ans; break; }
    const n = Number(ans);
    if (Number.isInteger(n) && n >= 1 && n <= PROVIDERS.length) { baseUrl = PROVIDERS[n - 1].baseUrl; break; }
    if (Number.isInteger(n) && n === PROVIDERS.length + 1) {
      const custom = (await ask('   Base URL (must start with http:// or https://): ')).trim();
      if (/^https?:\/\//.test(custom)) { baseUrl = custom; break; }
      abortIfEnded();
      console.log(red('   It must start with http:// or https://'));
      continue;
    }
    abortIfEnded();
    console.log(red('   Pick a number from the list, or paste a URL starting with http:// or https://'));
  }

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(baseUrl);
  let apiKey = '';
  while (apiKey === '') {
    apiKey = await ask('2. API key (input hidden): ', { secret: true });
    if (apiKey === '') {
      // local servers (Ollama, LM Studio) accept any value, so let the user pass
      if (isLocal) { apiKey = 'local'; break; }
      abortIfEnded();
      console.log(red('   API key is required. Paste it and press Enter.'));
      console.log(dim('   Local servers (Ollama, LM Studio) accept any value, e.g. "local".'));
      continue;
    }
    if (!rejectCommand(apiKey)) apiKey = '';
  }

  // Some gateways front several upstreams and list them as "upstream/model".
  // modelAlias shows them under one namespace; a base URL the user typed keeps
  // whatever the provider sends. aliasFor only sets it for the built-in gateway.
  let modelAlias = aliasFor(baseUrl);
  const probe = { baseUrl, apiKey, model: 'x', modelAlias };
  console.log(dim('\n   Checking connection...'));
  let models = [];
  let connErr = '';
  const connSpin = startSpinner('connecting');
  try {
    models = await fetchModels(probe);
  } catch (err) {
    connErr = String(err.message ?? err);
  }
  connSpin.stop();
  if (models.length > 0) {
    console.log(green(`   Connected. ${models.length} models available.`)
      + (modelAlias ? dim(`  shown as ${modelAlias}/*`) : ''));
  } else if (connErr) {
    // say what actually failed: a beginner must not be told "Connected" and
    // then hit an invisible wall three questions later
    console.log(yellow('   Could not reach the model list: ' + connErr));
    console.log(dim('   You can still continue: step 3 lets you type a model id by hand.'));
  } else {
    console.log(yellow('   Connected, but the server did not return a model list (many routers hide it).'));
  }

  const suggest = models.find(m => /gpt-4o-mini/i.test(m))
    ?? models.find(m => /flash/i.test(m))
    ?? models.find(m => /mini|fast|small/i.test(m))
    ?? models[0];
  // [m] during the test: the list again on a terminal, a typed id otherwise
  const askModel = async current => {
    if (models.length > 1 && canPickInteractive()) {
      const picked = await pickModelInteractive(models, current);
      if (picked && rejectCommand(picked)) return picked;
    }
    const m = await ask('   Model id: ');
    if (m === '') abortIfEnded();
    return m && rejectCommand(m) ? m : current;
  };
  let model = '';
  if (models.length > 1 && canPickInteractive()) {
    console.log(bold('3. Pick a model') + dim(` (${models.length} available · Esc to type an id)`));
    const picked = await pickModelInteractive(models, suggest);
    if (picked && rejectCommand(picked)) model = picked;
    if (model) console.log('   Model: ' + model);
  }
  while (model === '') {
    model = await ask('3. Model id' + (suggest ? ` (Enter = ${suggest})` : '') + ': ');
    if (model === '' && suggest) model = suggest;
    if (model === '') {
      abortIfEnded();
      console.log(red('   Model id is required.'));
      continue;
    }
    if (!rejectCommand(model)) model = '';
  }

  console.log(dim(`   Testing ${model}...`));
  let saved = false;
  while (!saved) {
    const t = await timedTest({ baseUrl, apiKey, model, modelAlias });
    if (t.ok) {
      console.log(green('   Works.') + dim(` Replied in ${t.secs}s: ${trunc(t.reply || '(empty)', 40)}`));
      saved = true;
      continue;
    }
    if (t.skipped) {
      console.log(yellow('   Test skipped. Saving anyway: if it does not answer later, use /model or /provider.'));
      saved = true;
      continue;
    }
    if (t.timeout) {
      // a slow or stuck provider: never hang here, let the user decide
      console.log(yellow(`   No reply after ${t.secs}s. The provider may be slow or this model may not answer.`));
      const choice = await ask('   [r]etry test, [m]odel, or [s]ave anyway? ');
      if (choice === '') abortIfEnded();
      if (/^m/i.test(choice)) model = await askModel(model);
      else if (/^s/i.test(choice)) saved = true;
      if (!saved) console.log(dim(`   Testing ${model}...`));
      continue;
    }
    {
      const err = t.error;
      console.log(red('   Test failed: ' + (err?.message ?? err)));
      const choice = await ask('   [r]etry key, [m]odel, [l]ist models, [b]ase url, or [s]ave anyway? ');
      if (choice === '') abortIfEnded();
      if (/^r/i.test(choice)) {
        apiKey = await ask('   API key: ', { secret: true });
        if (apiKey === '') abortIfEnded();
      } else if (/^m/i.test(choice)) {
        model = await askModel(model);
        console.log(dim(`   Testing ${model}...`));
      } else if (/^l/i.test(choice)) {
        try {
          const list = await fetchModels({ baseUrl, apiKey, model: 'x' });
          if (list.length === 0) { console.log(yellow('   The server sent no list. Use [m] to type an id.')); continue; }
          if (canPickInteractive()) {
            console.log(dim(`   ${list.length} models available:`));
            const picked = await pickModelInteractive(list, model);
            if (picked && rejectCommand(picked)) model = picked;
          } else {
            const show = list.slice(0, 15);
            console.log(dim(`   ${list.length} models available, showing ${show.length}:`));
            show.forEach((m, i) => console.log('   ' + (i + 1) + '. ' + m));
            const pick = await ask('   Number or full model id: ');
            if (pick === '') abortIfEnded();
            if (rejectCommand(pick)) {
              const n = Number(pick);
              model = Number.isInteger(n) && n >= 1 && n <= show.length ? show[n - 1] : pick;
            }
          }
          console.log(dim(`   Testing ${model}...`));
        } catch (listErr) {
          if (listErr?.aborted) throw listErr;
          console.log(red('   Could not list models: ' + listErr.message));
        }
      } else if (/^b/i.test(choice)) {
        baseUrl = await ask('   API base URL: ') || baseUrl;
        modelAlias = aliasFor(baseUrl);
        console.log(dim('   Testing again...'));
        try { models = await fetchModels({ baseUrl, apiKey, model: 'x', modelAlias }); } catch {}
      } else if (/^s/i.test(choice)) {
        saved = true;
      }
    }
  }

  if (!save) {
    console.log('');
    return { baseUrl, apiKey, model, modelAlias };
  }
  const cfg = saveConfig({ baseUrl, apiKey, model, modelAlias });
  console.log(green('   Saved to ~/.ineedcodes/config.json. You will not be asked again.'));
  console.log('');
  return cfg;
}
