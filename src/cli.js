#!/usr/bin/env node
// ineed: your terminal, now autonomous.
// First open asks for provider setup. After that, just say what you want.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const [MAJOR] = process.versions.node.split('.').map(Number);
if (!(MAJOR >= 20)) {
  console.error(`ineed needs Node.js 20 or newer. You have ${process.versions.node}.`);
  console.error('Install a newer Node from https://nodejs.org and try again.');
  process.exit(1);
}

const { loadConfig } = await import('./config.js');
const { VERSION, bold, dim, red, green, yellow, cyan, box } = await import('./ui.js');

const args = process.argv.slice(2);

if (args[0] === '--version' || args[0] === '-v') {
  console.log(`ineed ${VERSION}`);
  process.exit(0);
}

if (args[0] === '--help' || args[0] === '-h') {
  console.log(`
${bold('ineed')} ${dim(`v${VERSION}`)} - your terminal, now autonomous

  ${green('ineed')}                        interactive session (first open: setup)
  ${green('ineed "fix the build errors"')}  one-shot task
  ${green('ineed unlock')}                 set a custom developer keyword (default: "take me to jungle")
  ${green('ineed skills-sync')}            download the gated security skills (opt-in)
  ${green('ineed --reset')}                 redo provider setup
  ${green('ineed --version')}               show version

Inside a session, ${dim('/help')} lists the shortcuts. Or just talk to it.
`);
  process.exit(0);
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
    keyword = (await ask('Developer keyword: ', { secret: true })).trim();
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
  console.log(yellow('Gunakan dengan bijak: hanya untuk sistem yang kamu miliki izin untuk menguji.'));
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
  console.log(yellow('Gunakan dengan bijak: hanya untuk sistem yang kamu miliki izin untuk menguji.'));
  process.exit(0);
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
  const { fileURLToPath } = await import('node:url');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', ...args], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  // interactive session or setup
  const readline = await import('node:readline');
  const { makeInput } = await import('./ui.js');
  const { wizard } = await import('./wizard.js');
  const { clearConfig } = await import('./config.js');

  if (args[0] === '--reset') {
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
      if (err.aborted) { console.log(dim('\nSetup aborted. Run `ineed` to try again.')); process.exit(1); }
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
