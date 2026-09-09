// processes.js: background process tools (master prompt #25). Start dev servers or
// long commands, list them, tail their logs, stop them. Zero dependencies.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const registry = new Map(); // name -> { child, logPath, command, started, exited }
const LOG_DIR = path.join(os.tmpdir(), 'ineed-procs');

// kill a whole process group when possible: with shell:true the command runs as
// `sh -c ...`, and killing only the shell would orphan its children
const killEntry = (e, sig) => {
  if (!e.child.pid || e.exited) return;
  try {
    if (process.platform !== 'win32') {
      try { process.kill(-e.child.pid, sig); return; } catch {}
    }
    e.child.kill(sig);
  } catch {}
};

function cleanExit() {
  for (const [, e] of registry) killEntry(e, 'SIGKILL');
}
process.on('exit', cleanExit);

// graceful stop: SIGTERM first, SIGKILL only after a short grace period
function stopEntry(e) {
  killEntry(e, 'SIGTERM');
  const t = setTimeout(() => { if (!e.exited) killEntry(e, 'SIGKILL'); }, 2_000);
  if (typeof t.unref === 'function') t.unref();
}

const okName = n => /^[a-zA-Z0-9_-]{1,40}$/.test(String(n));

export const PROC_TOOL_DEFS = [
  {
    name: 'process_start',
    description: 'Start a long-running command in the background (dev server, watcher). Output goes to a log file.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' } }, required: ['name', 'command'] },
    proc: true, mutating: true
  },
  {
    name: 'process_status',
    description: 'List background processes with pid, command, and log path.',
    parameters: { type: 'object', properties: {} },
    proc: true
  },
  {
    name: 'process_output',
    description: 'Show the last lines of a background process log.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    proc: true
  },
  {
    name: 'process_stop',
    description: 'Stop one background process by name.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    proc: true, mutating: true
  }
];

export function runProcTool(name, input, cwd = process.cwd()) {
  const n = String(input.name ?? '');
  if (name !== 'process_status' && !okName(n)) return { output: 'Error: name must be letters, digits, _ or - (max 40).' };

  if (name === 'process_start') {
    const command = String(input.command ?? '').trim();
    if (!command) return { output: 'Error: empty command.' };
    if (registry.has(n) && !registry.get(n).exited) {
      return { output: `Error: "${n}" is already running (pid ${registry.get(n).child.pid}). Stop it first.` };
    }
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, n + '.log');
    const out = fs.openSync(logPath, 'a');
    let child;
    try {
      // run in the project the agent is working in, not the home directory.
      // detached on POSIX: the shell becomes a group leader so a later stop can
      // kill the whole tree, not just the shell
      child = spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', out, out],
        env: { ...process.env, NO_COLOR: '1' }
      });
    } catch (err) {
      fs.closeSync(out);
      return { output: `Error: ${err.message}` };
    }
    fs.closeSync(out);
    const entry = { child, logPath, command: command.slice(0, 120), started: Date.now(), exited: false };
    registry.set(n, entry);
    child.on('exit', () => { entry.exited = true; });
    return { output: `Started "${n}" (pid ${child.pid}). log: ${logPath}` };
  }

  if (name === 'process_status') {
    if (!registry.size) return { output: 'No background processes.' };
    return {
      output: [...registry.entries()].map(([name, e]) =>
        `${name}: pid ${e.child.pid}${e.exited ? ' (exited)' : ' (running)'} cmd: ${e.command} log: ${e.logPath}`
      ).join('\n')
    };
  }

  if (name === 'process_output') {
    const e = registry.get(n);
    if (!e) return { output: `Error: no process named "${n}".` };
    try {
      const log = fs.readFileSync(e.logPath, 'utf8');
      return { output: log.split('\n').slice(-40).join('\n') || '(log empty)' };
    } catch { return { output: '(log empty)' }; }
  }

  if (name === 'process_stop') {
    const e = registry.get(n);
    if (!e) return { output: `Error: no process named "${n}".` };
    stopEntry(e);
    registry.delete(n);
    return { output: `Stopped "${n}".` };
  }

  return { output: `Unknown process tool: ${name}` };
}

export function stopAllProcs() {
  for (const [, e] of registry) killEntry(e, 'SIGKILL');
}
