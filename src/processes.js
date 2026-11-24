// processes.js: background process tools (master prompt #25). Start dev servers or
// long commands, list them, tail their logs, stop them. Zero dependencies.

import { spawn, spawnSync } from 'node:child_process';
import { quietGitEnv } from './tools.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { isDestructive } from './tools.js';

const registry = new Map(); // name -> { child, logPath, command, started, exited }
const LOG_DIR = path.join(os.tmpdir(), 'ineed-procs');

// kill a whole process group when possible: with shell:true the command runs as
// `sh -c ...`, and killing only the shell would orphan its children
function groupGone(e) {
  if (e.groupGone) return true;
  if (!e.child.pid) return e.exited;
  try { process.kill(-e.child.pid, 0); return false; }
  catch (err) {
    if (err.code === 'ESRCH') e.groupGone = true;
    return !!e.groupGone;
  }
}
const finished = e => process.platform === 'win32' ? e.exited : e.exited && groupGone(e);

const killEntry = (e, sig) => {
  if (!e.child.pid || finished(e)) return false;
  try {
    if (process.platform === 'win32') {
      const exe = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');
      const r = spawnSync(exe, ['/PID', String(e.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
      return !r.error && r.status === 0;
    }
    process.kill(-e.child.pid, sig);
    return true;
  } catch { return false; }
};

function cleanExit() {
  for (const [, e] of registry) killEntry(e, 'SIGKILL');
}
process.on('exit', cleanExit);

// graceful stop: SIGTERM first, SIGKILL only after a short grace period
async function stopEntry(e) {
  if (process.platform !== 'win32') {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      if (groupGone(e)) return true;
      if (!killEntry(e, sig)) return groupGone(e);
      const until = Date.now() + 2000;
      do {
        if (groupGone(e)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < until);
    }
    return groupGone(e);
  }
  const exitedWithin = ms => new Promise(resolve => {
    if (e.exited) return resolve(true);
    const done = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => { e.child.off('close', done); resolve(e.exited); }, ms);
    e.child.once('close', done);
  });
  if (!killEntry(e, 'SIGTERM')) return false;
  if (await exitedWithin(2000)) return true;
  return killEntry(e, 'SIGKILL') && await exitedWithin(2000);
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
    // a background process is still a command: without this check the blocked
    // destructive list could be bypassed by running it detached
    if (isDestructive(command)) {
      return { output: 'Refused: that command is destructive. Run it yourself in a terminal if you are sure.' };
    }
    if (registry.has(n) && !finished(registry.get(n))) {
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
        env: { ...quietGitEnv(), NO_COLOR: '1' }
      });
    } catch (err) {
      fs.closeSync(out);
      return { output: `Error: ${err.message}` };
    }
    fs.closeSync(out);
    const entry = { child, logPath, command: command.slice(0, 120), started: Date.now(), exited: false };
    registry.set(n, entry);
    child.on('error', () => { entry.exited = true; });
    child.on('exit', () => { entry.exited = true; if (process.platform !== 'win32') groupGone(entry); });
    return { output: `Started "${n}" (pid ${child.pid}). log: ${logPath}` };
  }

  if (name === 'process_status') {
    if (!registry.size) return { output: 'No background processes.' };
    return {
      output: [...registry.entries()].map(([name, e]) =>
        `${name}: pid ${e.child.pid}${finished(e) ? ' (exited)' : ' (running)'} cmd: ${e.command} log: ${e.logPath}`
      ).join('\n')
    };
  }

  if (name === 'process_output') {
    const e = registry.get(n);
    if (!e) return { output: `Error: no process named "${n}".` };
    try {
      // read only the tail: a watcher can write a log far bigger than memory
      const size = fs.statSync(e.logPath).size;
      const fd = fs.openSync(e.logPath, 'r');
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      return { output: (text.split('\n').slice(-40).join('\n') || '(log empty)')
        + (size > len ? `\n[showing the last ${len} bytes of ${size}]` : '') };
    } catch { return { output: '(log empty)' }; }
  }

  if (name === 'process_stop') {
    const e = registry.get(n);
    if (!e) return { output: `Error: no process named "${n}".` };
    if (process.platform === 'win32' && e.exited) {
      registry.delete(n);
      return { output: `Process "${n}" already exited; descendants not verified.` };
    }
    return stopEntry(e).then(ok => {
      if (!ok) return { output: `Error: could not confirm stop of "${n}".` };
      if (registry.get(n) === e) registry.delete(n);
      return { output: `Stopped "${n}".` };
    });
  }

  return { output: `Unknown process tool: ${name}` };
}

export function stopAllProcs() {
  for (const [, e] of registry) killEntry(e, 'SIGKILL');
}
