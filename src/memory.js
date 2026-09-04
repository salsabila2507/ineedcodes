// memory.js: MemoryProvider abstraction. Default adapter shells out to the `icm` CLI.
// The agent never depends on icm internals; if icm is missing or slow, memory is silently empty.

import { spawn } from 'node:child_process';

function icm(args, timeoutMs = 10_000) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('icm', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(null); }, timeoutMs);
    child.stdout.on('data', c => {
      out += c.toString();
      if (out.length > 20_000) { try { child.kill('SIGKILL'); } catch {} }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(code === 0 ? out.slice(0, 8_000) : null);
    });
  });
}

export const ICMAdapter = {
  name: 'icm',

  // recall relevant durable memory for an objective. Returns '' when nothing/no icm.
  async recall(query) {
    if (!query?.trim()) return '';
    const out = await icm(['recall', query.slice(0, 200), '--limit', '3', '--read-only']);
    if (!out) return '';
    const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('memories['));
    const text = lines.join('\n').slice(0, 2_000);
    return /no (memories|results)|\(empty\)/i.test(text) ? '' : text;
  },

  // store durable knowledge. Fire-and-forget friendly. Never stores secrets (caller filters).
  async store(content) {
    if (!content?.trim()) return false;
    const out = await icm(['remember', content.trim().slice(0, 1_000)]);
    return out !== null;
  },

  async available() {
    return (await icm(['--help'], 5_000)) !== null;
  }
};

// pick the provider. Only icm exists today; the abstraction keeps that swappable.
// Disable with config memory:false or env INEED_NO_MEMORY=1 (used by the test suite).
export function getMemoryProvider(cfg) {
  if (cfg?.memory === false) return null;
  if (process.env.INEED_NO_MEMORY === '1') return null;
  return ICMAdapter;
}
