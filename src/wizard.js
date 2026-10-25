// wizard.js: first open. Bring-your-own-key: pick a normal provider (or paste any
// OpenAI-compatible base URL), enter your key, then choose a real model. Saved once.

import { fetchModels, chat } from './provider.js';
import { saveConfig } from './config.js';
import { aliasFor } from './builtin.js';
import { bold, dim, red, yellow, green, trunc, logo, BANNER, startSpinner } from './ui.js';

// Common OpenAI-compatible providers offered on first open. You bring the key.
// Any other endpoint works too: paste a full base URL at the prompt.
const PROVIDERS = [
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { name: 'Ollama (local, no key needed)', baseUrl: 'http://localhost:11434/v1' }
];

export async function testConnection(cfg, signal) {
  // proves reachability + auth + a working chat in one shot
  const m = await chat(cfg, [{ role: 'user', content: 'Reply with exactly: OK' }], undefined, signal);
  return String(m.content ?? '').trim();
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
  let model = '';
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
    let testSpin = null;
    try {
      testSpin = startSpinner('testing ' + model);
      const reply = await testConnection({ baseUrl, apiKey, model, modelAlias });
      testSpin.stop();
      console.log(green('   Works.') + dim(` Replied: ${trunc(reply, 40)}`));
      saved = true;
    } catch (err) {
      testSpin?.stop();
      console.log(red('   Test failed: ' + err.message));
      const choice = await ask('   [r]etry key, [m]odel, [l]ist models, [b]ase url, or [s]ave anyway? ');
      if (choice === '') abortIfEnded();
      if (/^r/i.test(choice)) {
        apiKey = await ask('   API key: ', { secret: true });
        if (apiKey === '') abortIfEnded();
      } else if (/^m/i.test(choice)) {
        const m = await ask('   Model id: ');
        if (m && rejectCommand(m)) model = m;
        console.log(dim(`   Testing ${model}...`));
      } else if (/^l/i.test(choice)) {
        try {
          const list = await fetchModels({ baseUrl, apiKey, model: 'x' });
          if (list.length === 0) { console.log(yellow('   The server sent no list. Use [m] to type an id.')); continue; }
          const show = list.slice(0, 15);
          console.log(dim(`   ${list.length} models available, showing ${show.length}:`));
          show.forEach((m, i) => console.log('   ' + (i + 1) + '. ' + m));
          const pick = await ask('   Number or full model id: ');
          if (pick === '') abortIfEnded();
          if (rejectCommand(pick)) {
            const n = Number(pick);
            model = Number.isInteger(n) && n >= 1 && n <= show.length ? show[n - 1] : pick;
          }
          console.log(dim(`   Testing ${model}...`));
        } catch (listErr) {
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
