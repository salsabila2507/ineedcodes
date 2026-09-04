// tools.js: real execution tools. Every result is { output: string } so the model never sees undefined.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

const underRoot = (p, root) => p === root || p.startsWith(root + path.sep);

const SECRET_PATTERNS = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.ssh\//,
  /(^|\/)id_rsa/,
  /(^|\/)id_ed25519/,
  /\.pem$/
];

function isSecret(abs) {
  return SECRET_PATTERNS.some(re => re.test(abs));
}

export const TOOLS = [
  {
    name: 'list_files',
    description: 'List files in a directory, recursive, skips node_modules/.git/dist.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'relative to working directory' } } },
    allowedInPlan: true
  },
  {
    name: 'read_file',
    description: 'Read a text file (UTF-8).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    allowedInPlan: true
  },
  {
    name: 'search_text',
    description: 'Search file contents for a string, returns file:line: matches (max 100).',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'directory, defaults to working directory' } }, required: ['pattern'] },
    allowedInPlan: true
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with content.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    allowedInPlan: false
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file with a new string (targeted edit).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'search', 'replace'] },
    allowedInPlan: false
  },
  {
    name: 'delete_file',
    description: 'Delete one file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    allowedInPlan: false
  },
  {
    name: 'todo',
    description: 'Maintain a visible task checklist for multi-step objectives. Replace the whole list each time.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    },
    allowedInPlan: true
  },
  {
    name: 'shell',
    description: 'Run a shell command in the working directory. Returns exit code with stdout and stderr.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    allowedInPlan: false
  }
];

export function runTool(name, input, cwd) {
  try {
    const abs = path.resolve(cwd, String(input.path ?? ''));
    if (!underRoot(abs, cwd)) return { output: 'Refused: path is outside the working directory.' };
    if (name === 'list_files') {
      const out = [];
      const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);
      (function walk(d, depth) {
        if (out.length > 500 || depth > 5) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (skip.has(e.name)) continue;
          out.push(e.isDirectory() ? e.name + '/' : e.name);
          if (e.isDirectory()) walk(path.join(d, e.name), depth + 1);
        }
      })(abs, 0);
      return { output: out.length ? out.join('\n') : '(empty)' };
    }
    if (name === 'read_file') {
      if (isSecret(abs)) return { output: 'Refused: that looks like a secret file, and secrets never enter the model context.' };
      const st = fs.statSync(abs);
      if (st.isDirectory()) return { output: 'Error: that is a directory, use list_files.' };
      return { output: fs.readFileSync(abs, 'utf8').slice(0, 60_000) };
    }
    if (name === 'search_text') {
      const pattern = String(input.pattern ?? '');
      if (!pattern) return { output: 'Error: empty pattern.' };
      const out = [];
      const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);
      (function walk(d, depth) {
        if (out.length >= 100 || depth > 5) return;
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= 100) return;
          if (skip.has(e.name)) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) { walk(p, depth + 1); continue; }
          if (e.name.startsWith('.env') || e.name.endsWith('.pem')) continue;
          let lines;
          try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
          for (let i = 0; i < lines.length && out.length < 100; i++) {
            if (lines[i].includes(pattern)) out.push(`${path.relative(cwd, p)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
        }
      })(abs, 0);
      return { output: out.length ? out.join('\n') : '(no matches)' };
    }
    if (name === 'write_file') {
      const content = String(input.content ?? '');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return { output: `Wrote ${path.relative(cwd, abs) || '.'} (${content.length} bytes).` };
    }
    if (name === 'edit_file') {
      if (isSecret(abs)) return { output: 'Refused: that looks like a secret file.' };
      const search = String(input.search ?? '');
      const replace = String(input.replace ?? '');
      if (!search) return { output: 'Error: empty search string.' };
      const src = fs.readFileSync(abs, 'utf8');
      const count = src.split(search).length - 1;
      if (count === 0) return { output: 'Error: search string not found in file.' };
      if (count > 1) return { output: `Error: search string matches ${count} times, give a longer unique string.` };
      fs.writeFileSync(abs, src.replace(search, replace));
      return { output: `Edited ${path.relative(cwd, abs)}.` };
    }
    if (name === 'delete_file') {
      fs.unlinkSync(abs);
      return { output: `Deleted ${path.relative(cwd, abs)}.` };
    }
    return { output: `Unknown tool: ${name}` };
  } catch (err) {
    return { output: `Error: ${err.message}` };
  }
}

const DESTRUCTIVE = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/(\s|$)/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard\s+origin/,
  /:\(\)\{\s*:\|:\s*&\s*\}\s*;:/
];

export function isDestructive(command) {
  return DESTRUCTIVE.some(re => re.test(command));
}

export function shellRun(command, cwd, signal) {
  return new Promise(resolve => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    let settled = false;
    let timedOut = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ output: `exit code: ${timedOut ? 'timeout' : child.exitCode}\n${out.slice(0, 20_000)}` });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
      out += '\n[timeout after 120s]';
    }, 120_000);
    const onAbort = () => { try { child.kill('SIGKILL'); } catch {} out += '\n[stopped by user]'; };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', c => {
      out += c.toString();
      if (out.length > 100_000) { try { child.kill('SIGKILL'); } catch {} }
    });
    child.stderr.on('data', c => { out += c.toString(); });
    child.on('close', finish);
    child.on('error', err => { out += `spawn error: ${err.message}`; finish(); });
  });
}
