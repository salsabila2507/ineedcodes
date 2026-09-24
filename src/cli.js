#!/usr/bin/env node
// ineed: your terminal, now autonomous.
// First open asks for provider setup. After that, just say what you want.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const [MAJOR] = process.versions.node.split('.').map(Number);
const args = process.argv.slice(2);

const { loadConfig } = await import('./config.js');
const { VERSION, bold, dim, red, green, yellow, cyan, box } = await import('./ui.js');

if (args[0] === '--version' || args[0] === '-v') {
  console.log(`ineed ${VERSION}`);
  process.exit(0);
}

if (args[0] === '--help' || args[0] === '-h') {
  console.log(`
${bold('ineed')} ${dim(`v${VERSION}`)} - your terminal, now autonomous

  ${green('ineed')}                        ${dim('open a session, then just talk to it')}
  ${green('ineed "bikin halaman login"')}  ${dim('do one task, then exit')}

  ${bold('Setup')}
  ${green('ineed provider')}              ${dim('pick a provider by number, switch API/key, add providers')}
  ${green('ineed --reset')}               ${dim('HAPUS semua provider+key, lalu setup ulang')}

  ${bold('Lainnya')}
  ${green('ineed --help, -h')}            ${dim('t bantuan ini')}
  ${green('ineed --version, -v')}         ${dim('t versi')}

  ${dim('Di dalam sesi: /help buat daftar perintah.')}
  ${dim('Mengetik "provider" atau "help" tanpa slash juga jalan.')}
`);
  process.exit(0);
}

if (!(MAJOR >= 20)) {
  console.error(`ineed needs Node.js 20 or newer. You have ${process.versions.node}.`);
  console.error('Install a newer Node from https://nodejs.org and try again.');
  process.exit(1);
}

// unlock: store the developer keyword locally so gated security skills activate here
if (args[0] === 'unlock') {
  const readline = await import('node:readline');
  const { makeInput, dim, gray } = await import('./ui.js');
  const keywordDir = process.env.INEED_CONFIG_DIR || path.join(os.homedir(), '.ineedcodes');
  const keywordFile = path.join(keywordDir, 'keyword');
  const given = args[1];
  let keyword = '';
  if (given) {
    keyword = given.trim();
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = makeInput(rl);
    try {
      keyword = (await ask('Developer keyword: ', { secret: true })).trim();
    } catch {
      rl.close();
      console.error(yellow('Cancelled. Nothing was saved.'));
      console.error(dim('Run ') + bold('ineed unlock') + dim(' again whenever you are ready.'));
      process.exit(1);
    }
    rl.close();
  }
  if (!keyword) {
    console.error(red('No keyword given. Nothing saved.'));
    process.exit(1);
  }
  fs.mkdirSync(keywordDir, { recursive: true });
  fs.writeFileSync(keywordFile, keyword, { mode: 0o600 });
  try { fs.chmodSync(keywordFile, 0o600); } catch {}
  console.log(green('Gated skills unlocked on this machine.'));
  console.log(dim('Saved to ' + keywordFile + ' (0600). Use them by mentioning the keyword in a task, e.g. /skills or "use the sqli skill".'));
  console.log(dim('(No unlock needed by default: saying "take me to jungle" in a task activates them. A custom keyword overrides the phrase.)'));
  console.log(yellow('Use responsibly: only on systems you are authorized to test.'));
  process.exit(0);
}

// skills-sync: opt-in download of the gated security skills from the source
// repository. The npm package ships a clean core, so skills live outside it.
if (args[0] === 'skills-sync') {
  const { skillsSync } = await import('./skillssync.js');
  console.log(dim('Downloading skills from the source repository...'));
  const r = skillsSync();
  if (!r.ok) {
    console.error(red('skills-sync failed: ' + r.error));
    process.exit(1);
  }
  console.log(green(`Synced ${r.copied} skill(s) to ${r.dest}.`));
  console.log(dim('Activate them in a task by saying "take me to jungle", or set a custom keyword with ineed unlock.'));
  console.log(yellow('Use responsibly: only on systems you are authorized to test.'));
  process.exit(0);
}

// provider: manage saved providers (any OpenAI-compatible API). Bare
// `ineed provider` is a numbered menu for beginners; `use <name>` also repairs
// the model by pulling the live list from the provider that was picked.
if (args[0] === 'provider') {
  const { normalize, addProvider, removeProvider, providerNames } = await import('./config.js');
  const { switchProviderLive } = await import('./switch.js');
  const cfg = loadConfig() ?? normalize({});
  const names = providerNames(cfg);
  const sub = (args[1] ?? '').trim();
  // `switchName` is set by the numbered menu, so the flow below never depends on
  // rewriting args (the subcommand was already resolved above)
  let switchName = null;

  if (!sub || sub === 'list') {
    if (!names.length) {
      console.log(yellow('No providers saved yet.'));
      console.log(dim('  Add one:  ') + bold('ineed provider add <name>') + dim('   (or just run ineed for first-time setup)'));
      process.exit(0);
    }
    console.log(bold('Providers'));
    names.forEach((n, i) => {
      const p = cfg.providers[n];
      console.log('  ' + (n === cfg.provider ? green('*') : ' ') + ' ' + dim(String(i + 1) + '. ') + bold(n)
        + dim('  ' + p.baseUrl + '  model: ' + (p.model || '(none)')));
    });
    // interactive only on a real terminal, so scripts and pipes keep working
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const readline0 = await import('node:readline');
      const { makeInput } = await import('./ui.js');
      const rl0 = readline0.createInterface({ input: process.stdin, output: process.stdout });
      const ask0 = makeInput(rl0);
      const answer = (await ask0('\nPick a provider (number or name, Enter to quit): ')).trim();
      rl0.close();
      if (!answer) process.exit(0);
      const pick = /^\d+$/.test(answer) ? names[Number(answer) - 1] : answer;
      if (!pick || !cfg.providers[pick]) {
        console.error(red('No such provider.') + dim('  choices: ' + names.join(', ')));
        process.exit(1);
      }
      switchName = pick;
    } else {
      console.log(dim('\n  switch: ineed provider use <name>   add: ineed provider add <name>   remove: ineed provider remove <name>'));
      process.exit(0);
    }
  }

  if (sub === 'use' || switchName) {
    const raw = switchName ?? (args[2] ?? '').trim();
    const name = /^\d+$/.test(raw) ? names[Number(raw) - 1] : raw;
    const r = await switchProviderLive(cfg, name ?? '');
    if (!r.ok) { console.error(red(r.error)); process.exit(1); }
    console.log(green('Provider: ' + r.cfg.provider) + dim('  ' + r.cfg.baseUrl + '  model: ' + r.cfg.model));
    if (r.modelChanged) {
      console.log(dim('  old model is not in that catalog, now using: ') + r.model);
    }
    if (r.fetchError) {
      console.log(yellow('  Could not fetch the model list: ' + r.fetchError));
      console.log(dim('  try again: ineed provider use ' + r.cfg.provider));
    }
    process.exit(0);
  }

  if (sub === 'add') {
    const name = (args[2] ?? '').trim();
    if (!name) { console.error(red('Usage: ineed provider add <name>')); process.exit(1); }
    const readline = await import('node:readline');
    const { makeInput } = await import('./ui.js');
    const { wizard } = await import('./wizard.js');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = makeInput(rl);
    try {
      const prof = await wizard(ask, { fromCommand: true, save: false });
      rl.close();
      const next = addProvider(cfg, name, prof);
      if (!next) { console.error(red('Could not save that provider.')); process.exit(1); }
      console.log(green('Provider "' + name + '" saved and active.') + dim('  ' + next.baseUrl + '  model: ' + next.model));
    } catch {
      rl.close();
      console.error(red('Aborted. Nothing saved.'));
      process.exit(1);
    }
    process.exit(0);
  }

  if (sub === 'remove') {
    const name = (args[2] ?? '').trim();
    const next = removeProvider(cfg, name);
    if (!next) { console.error(red('No provider named ' + (name || '(empty)') + '.')); process.exit(1); }
    console.log(green('Removed "' + name + '".') + (next.provider ? dim(' Active: ' + next.provider) : dim(' No providers left.')));
    process.exit(0);
  }

  console.error(red('Usage: ineed provider [list | use <name> | add <name> | remove <name>]'));
  process.exit(1);
}

// internal: one-shot worker. Spawned by the branch below, never run by users.
if (args[0] === '--child') {
  const task = args.slice(1).join(' ');
  const { runObjective } = await import('./agent.js');
  const cfg = loadConfig();
  if (!cfg) {
    console.error(red('No provider configured. Run ') + bold('ineed') + red(' first to set one up.'));
    process.exit(1);
  }
  try {
    const res = await runObjective(cfg, task, process.cwd(), [], {
      onTodos: list => {
        const mark = s => s === 'completed' ? green('✔') : s === 'in_progress' ? cyan('▸') : dim('○');
        console.log(box([bold('To-do'), ...list.map(t => '  ' + mark(t.status) + ' ' + t.content)]));
      }
    });
    if (res.aborted) {
      console.log('\n' + yellow('Stopped.') + dim(' Task did not finish (step limit or Ctrl+C). Re-run to continue.'));
      process.exit(2);
    }
    console.log('\n' + bold(green('Done')) + (res.changed?.length ? dim('  changed: ' + res.changed.join(', ')) : ''));
    if (res.answer) console.log('  ' + res.answer.split('\n').slice(0, 14).join('\n  '));
    process.exit(0);
  } catch (err) {
    console.error(red('Error: ' + err.message));
    process.exit(1);
  }
}

// one-shot task: keep this process alive as the parent, run the worker as a child.
// --reset/--resume/-r are interactive flags and must not be treated as an objective.
if (args.length > 0 && !['--reset', '--resume', '-r'].includes(args[0])) {
  // a mistyped flag must never turn into a paid task with a strange objective
  if (args[0].startsWith('-')) {
    console.error(red('Unknown option: ' + args[0]));
    console.error(dim('  available: --help, --version, --reset, --resume'));
    console.error(dim('  to run a task, drop the dashes: ineed "create hello.txt"'));
    process.exit(1);
  }
  const { fileURLToPath } = await import('node:url');
  console.log(dim('Working... (Ctrl+C to stop)'));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', ...args], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  // interactive session or setup
  const readline = await import('node:readline');
  const { makeInput } = await import('./ui.js');
  const { wizard } = await import('./wizard.js');
  const { clearConfig } = await import('./config.js');

  if (args[0] === '--reset') {
    // this wipes every saved provider and API key, so ask first
    const { CONFIG_FILE } = await import('./config.js');
    if (fs.existsSync(CONFIG_FILE)) {
      const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask0 = makeInput(rl0);
      const a = (await ask0('\nERASE every saved provider and API key? [y/N] ')).trim().toLowerCase();
      rl0.close();
      if (a !== 'y' && a !== 'yes') {
        console.log(dim('Cancelled. Nothing was deleted.'));
        process.exit(0);
      }
    }
    clearConfig();
    console.log(dim('Setup cleared. Let\'s set it up again.'));
  }

  let cfg = loadConfig();
  const fresh = !cfg;
  if (!cfg) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = makeInput(rl);
    try {
      cfg = await wizard(ask);
    } catch (err) {
      if (err.aborted) {
        console.log(yellow('\nSetup cancelled - nothing was saved.'));
        console.log(dim('Run ') + bold('ineed') + dim(' again whenever you are ready. This asks only once.'));
        process.exit(1);
      }
      throw err;
    }
    rl.close();
  }
  const { startSession } = await import('./session.js');
  const wasFresh = fresh || process.env.INEED_FRESH === '1';
  let resumeHistory = null;
  if (args[0] === '--resume' || args[0] === '-r') {
    const { listSessions } = await import('./sessions.js');
    const latest = listSessions()[0];
    if (latest?.history?.length) { resumeHistory = latest.history; console.log(dim(`Resuming ${Math.floor(latest.history.length / 2)} turns.`)); }
    else console.log(dim('No saved session found. Starting fresh.'));
  }
  await startSession(cfg, { fresh: wasFresh, resume: resumeHistory });
}
