// wizard.js: first open. Asks base URL, API key, then offers real models to pick from. Saved once, never asked again.

import { fetchModels, chat } from './provider.js';
import { saveConfig } from './config.js';
import { bold, dim, red, yellow, green, cyan, trunc, logo, BANNER, startSpinner } from './ui.js';

export async function testConnection(cfg, signal) {
  // proves reachability + auth + a working chat in one shot
  const m = await chat(cfg, [{ role: 'user', content: 'Reply with exactly: OK' }], undefined, signal);
  return String(m.content ?? '').trim();
}

export async function wizard(ask, { fromCommand = false } = {}) {
  const inputEnded = () => process.stdin.readableEnded === true && !process.stdout.isTTY;
  const abortIfEnded = () => { if (inputEnded()) throw Object.assign(new Error('Setup aborted: input ended.'), { aborted: true }); };

  console.log('');
  console.log(logo());
  console.log('');
  console.log(BANNER());
  console.log(bold('Welcome!') + dim(' Let\'s connect you to an AI provider. You only do this once.'));
  console.log(dim('Any OpenAI-compatible API works: OpenAI, OmniRoute, LM Studio, Ollama, vLLM, and more.'));
  console.log('');

  let baseUrl = '';
  while (true) {
    baseUrl = await ask('1. API base URL (example: https://api.openai.com/v1): ');
    if (/^https?:\/\//.test(baseUrl)) break;
    abortIfEnded();
    console.log(red('   It must start with http:// or https://'));
  }

  let apiKey = '';
  while (apiKey === '') {
    apiKey = await ask('2. API key (input hidden): ', { secret: true });
    if (apiKey === '') {
      abortIfEnded();
      console.log(red('   API key is required. Paste it and press Enter.'));
    }
  }

  const probe = { baseUrl, apiKey, model: 'x' };
  console.log(dim('\n   Checking connection...'));
  let models = [];
  const connSpin = startSpinner('connecting');
  try {
    models = await fetchModels(probe);
  } catch {}
  connSpin.stop();
  if (models.length > 0) {
    console.log(green(`   Connected. ${models.length} models available.`));
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
    }
  }

  console.log(dim(`   Testing ${model}...`));
  let saved = false;
  while (!saved) {
    let testSpin = null;
    try {
      testSpin = startSpinner('testing ' + model);
      const reply = await testConnection({ baseUrl, apiKey, model });
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
        model = await ask('   Model id: ') || model;
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
          const n = Number(pick);
          model = Number.isInteger(n) && n >= 1 && n <= show.length ? show[n - 1] : pick;
          console.log(dim(`   Testing ${model}...`));
        } catch (listErr) {
          console.log(red('   Could not list models: ' + listErr.message));
        }
      } else if (/^b/i.test(choice)) {
        baseUrl = await ask('   API base URL: ') || baseUrl;
        console.log(dim('   Testing again...'));
        try { models = await fetchModels({ baseUrl, apiKey, model: 'x' }); } catch {}
      } else if (/^s/i.test(choice)) {
        saved = true;
      }
    }
  }

  const cfg = saveConfig({ baseUrl, apiKey, model });
  console.log(green('   Saved to ~/.ineedcodes/config.json. You will not be asked again.'));
  console.log('');
  return cfg;
}
