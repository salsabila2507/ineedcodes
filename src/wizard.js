// wizard.js: first open. Asks base URL, API key, then offers real models to pick from. Saved once, never asked again.

import { fetchModels, chat } from './provider.js';
import { saveConfig } from './config.js';
import { BUILTIN } from './builtin.js';
import { bold, dim, red, yellow, green, cyan, trunc, logo, BANNER, startSpinner } from './ui.js';

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
  console.log(dim('Any OpenAI-compatible API works: OpenAI, OmniRoute, LM Studio, Ollama, vLLM, and more.'));
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

  let baseUrl = '';
  while (true) {
    // the built-in gateway is the default answer: beginners only press Enter
    baseUrl = await ask(`1. API base URL (Enter = ${BUILTIN.baseUrl}): `);
    if (baseUrl === '') baseUrl = BUILTIN.baseUrl;
    if (/^https?:\/\//.test(baseUrl)) break;
    abortIfEnded();
    console.log(red('   It must start with http:// or https://'));
  }

  let apiKey = '';
  while (apiKey === '') {
    const hint = baseUrl === BUILTIN.baseUrl
      ? dim('  (key from ineed.codes, or paste your own provider key here)')
      : '';
    apiKey = await ask('2. API key (input hidden): ' + hint, { secret: true });
    if (apiKey === '') {
      abortIfEnded();
      console.log(red('   API key is required. Paste it and press Enter.'));
      if (baseUrl === BUILTIN.baseUrl) {
        console.log(dim('   No key yet? Get one at https://ineed.codes, or use your own provider (OpenAI, Ollama, LM Studio, vLLM, a router).'));
      }
      continue;
    }
    if (!rejectCommand(apiKey)) apiKey = '';
  }

  const probe = { baseUrl, apiKey, model: 'x' };
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
    console.log(green(`   Connected. ${models.length} models available.`));
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
        console.log(dim('   Testing again...'));
        try { models = await fetchModels({ baseUrl, apiKey, model: 'x' }); } catch {}
      } else if (/^s/i.test(choice)) {
        saved = true;
      }
    }
  }

  if (!save) {
    console.log('');
    return { baseUrl, apiKey, model };
  }
  const cfg = saveConfig({ baseUrl, apiKey, model });
  console.log(green('   Saved to ~/.ineedcodes/config.json. You will not be asked again.'));
  console.log('');
  return cfg;
}
