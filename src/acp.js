// acp.js: drive another coding agent that speaks the Agent Client Protocol.
// ACP is JSON-RPC 2.0 over stdio: we start the agent, open a session in this
// folder, send the prompt, and render its updates. The agent owns the tools and
// the model, so this path needs no API key from ineed.

import { spawn, spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION } from './ui.js';

const PROTOCOL_VERSION = 1;
export const AUTH_REQUIRED = -32000;
// npm puts .cmd shims on Windows, which only start through a shell
const WIN = process.platform === 'win32';

// Agents that ship an ACP mode. `commands` are tried in order (a renamed adapter
// keeps working under its old name), then `paths`, where an installer puts the
// binary without always adding it to PATH.
export const AGENTS = [
  {
    id: 'antigravity', name: 'Antigravity', commands: ['agy'], args: ['acp'],
    why: 'Google Antigravity CLI, free with a Google account',
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash   (Windows: irm https://antigravity.google/cli/install.ps1 | iex)',
    login: 'agy acp --login',
    paths: [['.local', 'bin', 'agy'], ['AppData', 'Local', 'agy', 'bin', 'agy.exe']],
    // Google allows agy acp only while a person drives the session: never from serve, telegram or scripts
    personOnly: true
  },
  { id: 'opencode', name: 'OpenCode', commands: ['opencode'], args: ['acp'], why: 'OpenCode, has free models', install: 'npm install -g opencode-ai', login: 'opencode auth login' },
  { id: 'goose', name: 'Goose', commands: ['goose'], args: ['acp'], why: 'Goose by Block', install: 'see https://goose-docs.ai', login: 'goose configure' },
  { id: 'qwen', name: 'Qwen Code', commands: ['qwen'], args: ['--acp'], why: 'Qwen Code CLI', install: 'npm install -g @qwen-code/qwen-code', login: 'qwen' },
  { id: 'claude', name: 'Claude Code', commands: ['claude-agent-acp', 'claude-code-acp'], args: [], why: 'Claude Code through its ACP adapter, uses your Claude plan', install: 'npm install -g @agentclientprotocol/claude-agent-acp', login: 'claude   (then /login)' },
  { id: 'codex', name: 'Codex', commands: ['codex-acp'], args: [], why: 'Codex through its ACP adapter, uses your ChatGPT plan', install: 'npm install -g @agentclientprotocol/codex-acp', login: 'codex login' }
];

export function findAgent(id) {
  const key = String(id ?? '').toLowerCase();
  return AGENTS.find(a => a.id === key || a.name.toLowerCase() === key) ?? null;
}

const onPath = command => spawnSync(WIN ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0;

// Which agents this computer has, each with the command that starts it.
export function detect(agents = AGENTS, { home = os.homedir(), has = onPath, exists = fs.existsSync } = {}) {
  return agents.map(a => {
    const onPathCmd = (a.commands ?? []).find(c => has(c));
    const local = onPathCmd ? null : (a.paths ?? []).map(p => path.join(home, ...p)).find(p => exists(p));
    const command = onPathCmd ?? local ?? a.commands[0];
    return { ...a, command, found: Boolean(onPathCmd || local) };
  });
}

// One agent process, one session. Requests are matched to responses by id, and
// notifications (session/update) are handed to onUpdate as they arrive.
export function startAgent({ command, args = [], cwd, env = process.env, onUpdate = () => {}, onPermission, terminalAuth = false } = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'], shell: WIN, windowsHide: true });
  const pending = new Map();
  let nextId = 1;
  let sessionId = null;
  let stderr = '';
  let dead = null;
  let cancelled = false;

  const send = message => {
    if (dead) return;
    try { child.stdin.write(JSON.stringify(message) + '\n'); } catch { dead = 'the agent stopped reading'; }
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (dead) return reject(new Error(dead));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  // the agent may ask us things; answer what we can and refuse the rest clearly
  const answerClientCall = async (id, method, params) => {
    if (method === 'session/request_permission') {
      const options = params?.options ?? [];
      let pick = null;
      try {
        pick = onPermission
          ? await onPermission(params)
          : (options.find(o => o.kind === 'allow_always') ?? options.find(o => o.kind === 'allow_once'))?.optionId;
      } catch { pick = null; }
      // no answer, or an answer that is not one of the offered options, is a cancel: never guess "allow"
      const option = cancelled ? null : options.find(o => o.optionId === pick);
      return send(option
        ? { jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } }
        : { jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } });
    }
    // fs and terminal are not advertised, so an agent asking anyway gets a clear no
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `ineed does not provide ${method}` } });
  };

  const handle = line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method) return void answerClientCall(msg.id, msg.method, msg.params);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (!msg.error) return resolve(msg.result);
      return reject(Object.assign(new Error(msg.error.message ?? 'agent error'), { code: msg.error.code, data: msg.error.data }));
    }
    if (msg.method === 'session/update') {
      onUpdate(msg.params?.update ?? {});
      return;
    }
    // any other notification needs no answer, and replying to one would break JSON-RPC
  };

  readline.createInterface({ input: child.stdout }).on('line', handle);
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.on('error', err => { dead = `cannot start ${command}: ${err.message}`; });
  child.stdin.on('error', () => { dead = dead ?? 'the agent stopped reading'; });
  child.on('close', code => {
    dead = dead ?? `the agent exited (code ${code})` + (stderr ? ': ' + stderr.trim().split('\n').slice(-2).join(' ') : '');
    for (const { reject } of pending.values()) reject(new Error(dead));
    pending.clear();
  });

  const api = {
    child,
    stop: () => {
      try {
        // through a shell on Windows the agent is a grandchild, so end the whole tree
        if (WIN && child.pid && child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        else child.kill('SIGTERM');
      } catch {}
    },
    get sessionId() { return sessionId; },
    async initialize() {
      const r = (await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: Boolean(terminalAuth) } },
        clientInfo: { name: 'ineed', title: 'ineed', version: VERSION }
      })) ?? {};
      if (r.protocolVersion !== undefined && r.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`the agent speaks ACP version ${r.protocolVersion}, ineed speaks version ${PROTOCOL_VERSION}. Update ineed or the agent.`);
      }
      return r;
    },
    authenticate: methodId => request('authenticate', { methodId }),
    async newSession(dir) {
      const r = await request('session/new', { cwd: dir, mcpServers: [] });
      sessionId = r?.sessionId ?? null;
      if (!sessionId) throw new Error('the agent did not return a session');
      return sessionId;
    },
    prompt: async (text, sid = sessionId) => {
      cancelled = false;
      return request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: String(text) }] });
    },
    // after a cancel, permission questions still open must be answered "cancelled"
    cancel: (sid = sessionId) => { cancelled = true; notify('session/cancel', { sessionId: sid }); }
  };
  return api;
}

// What one session/update means on screen. Returns null for updates that carry
// nothing worth printing (plans, mode changes, usage meters).
export function describeUpdate(update) {
  const kind = update?.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const text = update?.content?.type === 'text' ? update.content.text : '';
    return text ? { stream: true, text } : null;
  }
  if (kind === 'agent_thought_chunk') return null;
  if (kind === 'tool_call') return { line: '  · ' + String(update?.title ?? update?.kind ?? 'tool') };
  if (kind === 'tool_call_update') {
    const status = String(update?.status ?? '');
    if (status === 'completed' || status === 'failed') {
      return { line: '    ' + (status === 'failed' ? '✗' : '✓') + ' ' + String(update?.title ?? 'tool') };
    }
    return null;
  }
  return null;
}

// env keys a login descriptor may not set without the user: they change which
// program runs or what it trusts (see ACP "Terminal authentication", launch safety)
const UNSAFE_ENV = /^(PATH|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|BASH_ENV|ENV|PERL5LIB|RUBYOPT|.*_PROXY|SSL_CERT_.*|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE)$/i;

export const authKind = m => (m?.type ?? 'agent');

// A "terminal" login runs the agent itself, interactively, with the descriptor's
// extra args. Resolves true when it exits 0.
export function runTerminalLogin({ command, args = [], cwd, method, env = process.env }) {
  const extra = Object.fromEntries(Object.entries(method?.env ?? {}).filter(([k, v]) => !UNSAFE_ENV.test(k) && typeof v === 'string'));
  return new Promise(resolve => {
    const child = spawn(command, [...args, ...(method?.args ?? []).map(String)], { cwd, env: { ...env, ...extra }, stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

// Start the agent and open a session, signing in when the agent asks for it.
// chooseAuth(methods) returns the method to use, or null to give up; it is only
// asked when session/new fails with auth_required.
// aroundLogin wraps the interactive login so the caller can hand it the keyboard.
export async function connect({ command, args = [], cwd, onUpdate, onPermission, chooseAuth = null, terminalAuth = false, aroundLogin = f => f(), env }) {
  let agent = startAgent({ command, args, cwd, env, onUpdate, onPermission, terminalAuth });
  let info = await agent.initialize();
  for (let attempt = 0; ; attempt++) {
    try {
      await agent.newSession(cwd);
      return { agent, info };
    } catch (err) {
      if (err?.code !== AUTH_REQUIRED) { agent.stop(); throw err; }
      // a terminal login is the agent's own sign-in screen, the most reliable choice, so it goes first
      const methods = (info.authMethods ?? []).filter(m => authKind(m) === 'agent' || (terminalAuth && authKind(m) === 'terminal'))
        .sort((x, y) => (authKind(y) === 'terminal') - (authKind(x) === 'terminal'));
      const method = attempt < 2 && methods.length && chooseAuth ? await chooseAuth(methods) : null;
      if (!method) {
        agent.stop();
        const names = (info.authMethods ?? []).map(m => m.name ?? m.id).join(', ');
        throw Object.assign(new Error('the agent needs you to sign in first' + (names ? ` (it offers: ${names})` : '')), { code: AUTH_REQUIRED, authMethods: info.authMethods ?? [] });
      }
      if (authKind(method) === 'terminal') {
        agent.stop();
        if (!(await aroundLogin(() => runTerminalLogin({ command, args, cwd, method, env })))) throw Object.assign(new Error('sign-in did not finish'), { code: AUTH_REQUIRED });
        agent = startAgent({ command, args, cwd, env, onUpdate, onPermission, terminalAuth });
        info = await agent.initialize();
      } else {
        await agent.authenticate(method.id).catch(e => { agent.stop(); throw e; });
      }
    }
  }
}

// Run one task to completion. Returns the agent's prompt result ({ stopReason }).
export async function runTask({ command, args, cwd, text, onUpdate, onPermission, chooseAuth, env }) {
  const { agent } = await connect({ command, args, cwd, onUpdate, onPermission, chooseAuth, env });
  try {
    return await agent.prompt(text);
  } finally {
    agent.stop();
  }
}
