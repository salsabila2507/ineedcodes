#!/usr/bin/env node
// ineed: your terminal, now autonomous.
// First open asks for provider setup. After that, just say what you want.

import { spawn } from 'node:child_process';

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
  ${green('ineed --reset')}                 redo provider setup
  ${green('ineed --version')}               show version

Inside a session, ${dim('/help')} lists the shortcuts. Or just talk to it.
`);
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

// one-shot task: keep this process alive as the parent, run the worker as a child
if (args.length > 0 && args[0] !== '--reset') {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--child', ...args], { stdio: 'inherit' });
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
