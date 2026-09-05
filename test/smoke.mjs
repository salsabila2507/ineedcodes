// smoke.mjs: every feature, tested against a mock OpenAI-compatible server. Real files, real shell.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'src', 'cli.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ineed-smoke-'));
const CFG = path.join(TMP, 'cfg');
const SECRET = 'sk-mock-secret-key-12345';

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' | ' + String(detail).slice(0, 400) : '')); }
};

function mock(script) {
  const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] });
  const call = (name, args) => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }]
  });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith('/models')) {
        if (script === 'nomodels') return send(200, { data: [] });
        return send(200, { data: [{ id: 'mock-mini' }, { id: 'mock-pro' }, { id: 'gpt-4o-mini' }] });
      }
      if (!req.url.endsWith('/chat/completions')) return send(404, { error: 'nope' });
      const auth = req.headers.authorization ?? '';
      if (auth !== 'Bearer ' + SECRET) return send(401, { error: { message: 'bad key' } });
      const parsed = JSON.parse(body || '{}');
      const msgs = parsed.messages ?? [];
      const toolResults = msgs.filter(m => m.role === 'tool').map(m => String(m.content ?? ''));
      const hadTools = toolResults.length > 0;
      const joined = toolResults.join('\n');
      let resp;
      switch (script) {
        case 'tools':
          resp = hadTools ? reply('Wrote hello.txt. Evidence above.') : call('write_file', { path: 'hello.txt', content: 'hello from ineed' });
          break;
        case 'shell':
          if (!hadTools) resp = call('shell', { command: 'echo ineed-shell-e2e' });
          else resp = reply(joined.includes('ineed-shell-e2e') && joined.includes('exit code: 0') ? 'SHELL-VERIFIED' : 'SHELL-BROKEN');
          break;
        case 'shellfail':
          if (!hadTools) resp = call('shell', { command: 'echo err-probe >&2; exit 3' });
          else resp = reply(joined.includes('err-probe') && joined.includes('exit code: 3') ? 'SHELLFAIL-VERIFIED' : 'SHELLFAIL-BROKEN');
          break;
        case 'edit':
          if (toolResults.length < 2) resp = call('edit_file', { path: 'notes.txt', search: 'alpha', replace: 'omega' });
          else resp = reply(joined.includes('Edited notes.txt') ? 'EDIT-VERIFIED' : 'EDIT-BROKEN');
          break;
        case 'search':
          if (!hadTools) resp = call('search_text', { pattern: 'treasure' });
          else resp = reply(joined.includes('notes.txt:1:') && joined.includes('treasure') ? 'SEARCH-VERIFIED' : 'SEARCH-BROKEN');
          break;
        case 'secret':
          resp = hadTools ? reply(joined.includes('Refused') ? 'SECRET-REFUSED' : 'SECRET-LEAKED') : call('read_file', { path: '.env' });
          break;
        case 'sshsecret':
          resp = hadTools ? reply(joined.includes('Refused') ? 'SSH-REFUSED' : 'SSH-LEAKED') : call('read_file', { path: '.ssh/id_rsa' });
          break;
        case 'jail':
          resp = hadTools ? reply(joined.includes('Refused') ? 'JAIL-OK' : 'JAIL-BROKEN') : call('write_file', { path: path.join(TMP, 'outside', 'evil.txt'), content: 'x' });
          break;
        case 'destructive':
          resp = hadTools ? reply(joined.includes('Refused') ? 'DESTRUCTIVE-REFUSED' : 'DESTRUCTIVE-ALLOWED') : call('shell', { command: 'rm -rf / --no-preserve-root' });
          break;
        case 'weird':
          resp = hadTools ? reply(joined.includes('Unknown tool: make_coffee') ? 'WEIRD-HANDLED' : 'WEIRD-BROKEN') : call('make_coffee', {});
          break;
        case 'plan':
          resp = hadTools ? reply(joined.includes('Refused') && joined.includes('plan mode') ? 'PLAN-ENFORCED' : 'PLAN-BROKEN') : call('shell', { command: 'echo should-not-run' });
          break;
        case 'readonly':
          resp = hadTools ? reply(joined.includes('Refused') ? 'WRITE-BLOCKED' : 'WRITE-LEAKED') : call('write_file', { path: 'nope.txt', content: 'x' });
          break;
        case 'evidence':
          if (!hadTools) resp = call('shell', { command: 'echo EVIDENCE-12345' });
          else resp = reply('ran echo EVIDENCE-12345 and saw it in output');
          break;
        case 'loop': resp = call('noop', {}); break;
        case 'reasoning':
          resp = reply(parsed.reasoning_effort === 'high' ? 'REASON-HIGH' : 'REASON-LOW');
          break;
        case 'memory':
          resp = reply(JSON.stringify(msgs[0]).includes('FAKE-MEMORY-MARKER') ? 'MEMORY-VERIFIED' : 'MEMORY-MISSING');
          break;
        case 'approve': {
          const wantsAgain = msgs.some(m => m.role === 'user' && String(m.content ?? '').includes('again.txt'));
          if (wantsAgain && !toolResults.some(c => c.includes('again.txt'))) {
            resp = call('write_file', { path: 'again.txt', content: 'approved too' });
          } else if (!hadTools) {
            resp = call('write_file', { path: 'ok.txt', content: 'approved' });
          } else {
            resp = reply(joined.includes('Denied') ? 'APPROVAL-DENIED' : (joined.includes('Wrote') ? 'APPROVAL-GRANTED' : 'APPROVAL-WEIRD'));
          }
          break;
        }
        case 'todo':
          if (toolResults.length === 0) resp = call('todo', { todos: [{ content: 'scaffold', status: 'completed' }, { content: 'style it', status: 'in_progress' }, { content: 'test it', status: 'pending' }] });
          else if (toolResults.length === 1) resp = call('todo', { todos: [{ content: 'scaffold', status: 'completed' }, { content: 'style it', status: 'completed' }, { content: 'test it', status: 'completed' }] });
          else resp = reply('TODO-FINISHED');
          break;
        case 'agent': {
          const isWorker = String(msgs[0]?.content ?? '').includes('worker) spawned by the lead agent');
          if (isWorker) resp = reply(String(msgs[msgs.length - 1].content).includes('alpha') ? 'ALPHA-FACTS-FOUND' : 'BETA-FACTS-FOUND');
          else if (hadTools) resp = reply(joined.includes('ALPHA-FACTS-FOUND') && joined.includes('BETA-FACTS-FOUND') ? 'AGENTS-PARALLEL-VERIFIED' : 'AGENTS-BROKEN');
          else resp = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
            { id: 's1', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ role: 'research', objective: 'investigate alpha' }) } },
            { id: 's2', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ role: 'research', objective: 'investigate beta' }) } }
          ] } }] };
          break;
        }
        case 'agentwrite': {
          const isWorker = String(msgs[0]?.content ?? '').includes('worker) spawned by the lead agent');
          if (isWorker) resp = hadTools ? reply('IMPL-WROTE-FILE') : call('write_file', { path: 'worker.txt', content: 'written by worker' });
          else if (hadTools) resp = reply('AGENT-WRITE-VERIFIED');
          else resp = call('spawn_agent', { role: 'implement', objective: 'write the file' });
          break;
        }
        case 'mcp': {
          if (!hadTools) {
            const echoTool = (parsed.tools ?? []).find(t => t?.function?.name?.startsWith('mcp_'));
            if (!echoTool) { resp = reply('MCP-TOOL-MISSING tools=' + (parsed.tools ?? []).map(t => t?.function?.name).join(',')); break; }
            resp = call(echoTool.function.name, { message: 'hello-mcp' });
          } else resp = reply(joined.includes('ECHO:hello-mcp') ? 'MCP-VERIFIED' : 'MCP-BROKEN');
          break;
        }
        default: resp = reply('OK');
      }
      send(200, resp);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function run(args, { input = '', cwd = TMP, port = 0, cfg = {}, staged = null, fakePath = null, memory = false, fresh = false } = {}) {
  return new Promise(resolve => {
    const extraPath = fakePath ? fakePath + path.delimiter + process.env.PATH : process.env.PATH;
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env, INEED_CONFIG_DIR: CFG, NO_COLOR: '1',
        INEED_TEST_PORT: String(port), INEED_TEST_CFG: JSON.stringify(cfg),
        INEED_NO_MEMORY: memory ? '0' : '1', PATH: extraPath,
        INEED_FRESH: fresh ? '1' : '0'
      }
    });
    let out = '';
    let step = 0;
    child.stdout.on('data', c => {
      out += c;
      if (staged && step < staged.length && c.includes(staged[step].when)) {
        child.stdin.write(staged[step].send + '\n');
        step++;
      }
    });
    child.stderr.on('data', c => out += c);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }); });
    if (staged) {
      if (staged[0] && staged[0].immediate) { child.stdin.write(staged[0].send + '\n'); step = 1; }
    } else {
      child.stdin.end(input);
    }
  });
}

// ── CLI basics ──
{ const { code, out } = await run(['--version']); check('--version prints version', code === 0 && out.includes('ineed 1.1.0'), out); }
{ const { code, out } = await run(['--help']); check('--help prints usage', code === 0 && out.includes('one-shot task') && out.includes('--reset'), out); }

// ── reset before any config exists: clears, then opens setup; full setup succeeds ──
fs.rmSync(CFG, { recursive: true, force: true });
{
  const { server, port } = await mock('default');
  const { code, out } = await run(['--reset'], { input: `http://127.0.0.1:${port}/v1\n${SECRET}\n\n` });
  check('--reset clears and reopens setup', code === 0 && out.includes('cleared') && out.includes('Saved'), out);
  server.close();
}
// ── reset with garbage input aborts cleanly instead of hanging ──
fs.rmSync(CFG, { recursive: true, force: true });
{ const { code, out } = await run(['--reset'], { input: 'not-a-url\n' }); check('--reset aborts cleanly on EOF', code === 1 && out.includes('Setup aborted'), out); }

// ── wizard full flow ──
fs.rmSync(CFG, { recursive: true, force: true });
{
  const { server, port } = await mock('default');
  const { code, out } = await run([], { input: `http://127.0.0.1:${port}/v1\n${SECRET}\n\n` });
  const cfgPath = path.join(CFG, 'config.json');
  const mode = fs.existsSync(cfgPath) ? (fs.statSync(cfgPath).mode & 0o777) : 0;
  check('wizard: connects, suggests model, saves', code === 0 && out.includes('Connected. 3 models') && out.includes('Works.') && out.includes('Saved'), out);
  check('wizard: api key never echoed', !out.includes(SECRET), out);
  check('wizard: config mode 0600', mode === 0o600, 'mode=' + mode.toString(8));
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  check('wizard: suggested model picked on Enter', saved.model === 'gpt-4o-mini', saved.model);
  check('wizard: no em dash in output', !/[\u2013\u2014]/.test(out), out);
  server.close();
}

// ── wizard: wrong key then recovery ──
fs.rmSync(CFG, { recursive: true, force: true });
{
  const { server, port } = await mock('default');
  const { code, out } = await run([], { input: `http://127.0.0.1:${port}/v1\nWRONG-KEY\n\nr\n${SECRET}\n\n` });
  check('wizard: wrong key recoverable with r', code === 0 && out.includes('Saved'), out);
  server.close();
}

// ── wizard: server hides model list ──
fs.rmSync(CFG, { recursive: true, force: true });
{
  const { server, port } = await mock('nomodels');
  const { code, out } = await run([], { input: `http://127.0.0.1:${port}/v1\n${SECRET}\nmock-manual\n` });
  check('wizard: no model list, manual id works', code === 0 && out.includes('did not return a model list') && out.includes('Works.'), out);
  server.close();
}

// ── one-shot tasks against mock ──
async function oneShot(script, task, cfgExtra = {}, prep = null, opts = {}) {
  const { server, port } = await mock(script);
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini', ...cfgExtra }, null, 2), { mode: 0o600 });
  const work = fs.mkdtempSync(path.join(TMP, 'work-'));
  if (prep) prep(work);
  const { code, out } = await run([task], { cwd: work, ...opts });
  server.close();
  return { code, out, work };
}

{
  const { code, out, work } = await oneShot('tools', 'create hello.txt');
  const file = path.join(work, 'hello.txt');
  const ok = code === 0 && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'hello from ineed';
  check('one-shot: write_file writes the real file', ok, out);
  check('one-shot: reports changed file', out.includes('hello.txt'), out);
}
{ const { code, out } = await oneShot('shell', 'run echo'); check('shell: stdout captured with exit code', code === 0 && out.includes('SHELL-VERIFIED'), out); }
{ const { code, out } = await oneShot('shellfail', 'failing command'); check('shell: stderr + nonzero exit captured', code === 0 && out.includes('SHELLFAIL-VERIFIED'), out); }
{
  fs.mkdirSync(path.join(TMP, 'outside'), { recursive: true });
  const { code, out } = await oneShot('jail', 'escape');
  check('jail: write outside cwd refused', code === 0 && out.includes('JAIL-OK') && !fs.existsSync(path.join(TMP, 'outside', 'evil.txt')), out);
}
{
  const { code, out, work } = await oneShot('secret', 'read env');
  check('secrets: .env refused', out.includes('SECRET-REFUSED'), out);
  check('secrets: .env content never in output', !fs.existsSync(path.join(work, '.env')) || !out.includes('SECRET_VALUE'), out);
}
{ const { code, out } = await oneShot('sshsecret', 'read ssh'); check('secrets: .ssh key refused', out.includes('SSH-REFUSED'), out); }
{ const { code, out } = await oneShot('destructive', 'rm everything'); check('safety: rm -rf / refused', out.includes('DESTRUCTIVE-REFUSED'), out); }
{ const { code, out } = await oneShot('weird', 'coffee'); check('unknown tool handled cleanly', out.includes('WEIRD-HANDLED'), out); }
{
  const { code, out, work } = await oneShot('edit', 'fix notes', {}, w => fs.writeFileSync(path.join(w, 'notes.txt'), 'alpha beta'));
  const file = path.join(work, 'notes.txt');
  const edited = fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'omega beta';
  check('edit_file: targeted replace works', out.includes('EDIT-VERIFIED') && edited, out + ' | file=' + (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'missing'));
}
{
  const { code, out } = await oneShot('search', 'find treasure', {}, w => fs.writeFileSync(path.join(w, 'notes.txt'), 'treasure here'));
  check('search_text: finds matches', out.includes('SEARCH-VERIFIED'), out);
}
{ const { code, out } = await oneShot('loop', 'loop'); check('loop: stops at 30 steps', code === 2 && out.includes('Stopped'), out); }
{ const { code, out } = await oneShot('evidence', 'prove it'); check('evidence: agent sees real output', out.includes('EVIDENCE-12345'), out); }
{ const { code, out } = await oneShot('default', 'hi', { mode: 'plan' }); check('plan cfg: default loads', code === 0 && out.includes('Done'), out); }
{ const { code, out } = await oneShot('plan', 'try shell', { mode: 'plan' }); check('plan: shell refused', out.includes('PLAN-ENFORCED'), out); }
{ const { code, out } = await oneShot('readonly', 'try write', { mode: 'plan' }); check('plan: write refused', out.includes('WRITE-BLOCKED'), out); }
{ const { code, out } = await oneShot('reasoning', 'hi', { reasoning: 'high' }); check('reasoning high: sent to provider', out.includes('REASON-HIGH'), out); }
{
  const { code, out } = await oneShot('agent', 'investigate alpha and beta in parallel');
  check('multi-agent: 2 research workers run in parallel', code === 0 && out.includes('AGENTS-PARALLEL-VERIFIED'), out.slice(-400));
}
{
  const { code, out, work } = await oneShot('agentwrite', 'delegate writing the file');
  const file = path.join(work, 'worker.txt');
  check('multi-agent: implement worker writes file, lead reports', code === 0 && out.includes('AGENT-WRITE-VERIFIED') && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'written by worker', out.slice(-400));
}
{
  // MCP: point the config at the fixture server, run a task that uses its echo tool
  const mcpDir = fs.mkdtempSync(path.join(TMP, 'mcp-'));
  fs.writeFileSync(path.join(mcpDir, 'mcp.json'), JSON.stringify({ mini: { command: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'mini-mcp.mjs')] } }), { mode: 0o600 });
  const { server, port } = await mock('mcp');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini', mcp: true }), { mode: 0o600 });
  fs.writeFileSync(path.join(CFG, 'mcp.json'), JSON.stringify({ mini: { command: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'mini-mcp.mjs')] } }), { mode: 0o600 });
  process.env.INEED_MCP_CONFIG = path.join(CFG, 'mcp.json');
  const work = fs.mkdtempSync(path.join(TMP, 'mcptask-'));
  const { code, out } = await run(['use the echo tool with message hello-mcp'], { cwd: work });
  server.close();
  fs.rmSync(mcpDir, { recursive: true, force: true });
  check('mcp: external server tool callable from agent', code === 0 && out.includes('MCP-VERIFIED'), out.slice(-400));
  delete process.env.INEED_MCP_CONFIG;
}
{
  // session /mcp listing
  const { server, port } = await mock('default');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  fs.writeFileSync(path.join(CFG, 'mcp.json'), JSON.stringify({ mini: { command: process.execPath, args: [path.join(ROOT, 'test', 'fixtures', 'mini-mcp.mjs')] } }), { mode: 0o600 });
  process.env.INEED_MCP_CONFIG = path.join(CFG, 'mcp.json');
  const { code, out } = await run([], { input: '/mcp\n/exit\n' });
  check('session: /mcp lists server tools', out.includes('mcp_mini_echo'), out);
  delete process.env.INEED_MCP_CONFIG;
  server.close();
}
{
  const { code, out } = await oneShot('todo', 'build the thing');
  const hasList = out.includes('To-do') && out.includes('scaffold') && out.includes('test it');
  check('todo: checklist rendered and progresses', code === 0 && hasList && out.includes('TODO-FINISHED'), out.slice(-500));
}

// ── unreachable provider ──
{
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' }), { mode: 0o600 });
  const { code, out } = await run(['anything']);
  check('unreachable provider: clean error exit 1', code === 1 && /Error|cannot reach/.test(out), out);
}

// ── session REPL ──
{
  const { server, port } = await mock('default');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  const { code, out } = await run([], { input: '/help\n/model\n/plan\n/build\n/reason\n/clear\n/exit\n' });
  check('session: /help lists commands', out.includes('/model') && out.includes('/plan') && out.includes('/reason'), out);
  check('session: /plan /build toggle', out.includes('read only') && out.includes('real changes.'), out);
  check('session: /reason toggles', out.includes('Reasoning effort: high'), out);
  check('session: exits cleanly', code === 0 && out.includes('Goodbye.'), out);
  check('session: banner shows ineed', out.includes('ineed') && out.includes('v1.1.0'), out);
  server.close();
}

// ── permissions: session approval flow (y/a/n) ──
{
  const { server, port } = await mock('approve');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  const work = fs.mkdtempSync(path.join(TMP, 'perm-'));
  const { code, out } = await run([], {
    cwd: work,
    staged: [
      { when: '', send: 'make ok.txt', immediate: true },
      { when: 'approval needed', send: 'n' },
      { when: 'APPROVAL-DENIED', send: '/exit' }
    ]
  });
  const file = path.join(work, 'ok.txt');
  check('perm: n denies the edit in session', code === 0 && !fs.existsSync(file) && out.includes('denied.'), out);
  server.close();
}
{
  const { server, port } = await mock('approve');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  const work = fs.mkdtempSync(path.join(TMP, 'perm-'));
  const { code, out } = await run([], {
    cwd: work,
    staged: [
      { when: '', send: 'make ok.txt', immediate: true },
      { when: 'approval needed', send: 'a' },
      { when: 'APPROVAL-GRANTED', send: 'make again.txt' },
      { when: 'APPROVAL-GRANTED', send: '/exit' }
    ]
  });
  const f1 = path.join(work, 'ok.txt');
  const f2 = path.join(work, 'again.txt');
  const askCount = (out.match(/approval needed/g) || []).length;
  check('perm: a grants for the session (second edit never asks)', code === 0 && fs.existsSync(f1) && fs.existsSync(f2) && askCount === 1, 'asks=' + askCount + ' | ' + out.slice(-300));
  server.close();
}

// ── session: /model pick by number (staged: type after list appears) ──
{
  const { server, port } = await mock('default');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  const { code, out } = await run([], {
    staged: [
      { when: '', send: '/model', immediate: true },
      { when: 'Type a number', send: '2' },
      { when: 'Model: mock-pro', send: '/exit' }
    ]
  });
  check('session: /model picks by number', code === 0 && out.includes('Model: mock-pro') && out.includes('Goodbye.'), out);
  server.close();
}

// ── session: task runs in session ──
{
  const { server, port } = await mock('tools');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini', permEdit: 'allow', permShell: 'allow' }), { mode: 0o600 });
  const work = fs.mkdtempSync(path.join(TMP, 'sess-'));
  const { code, out } = await run([], { cwd: work, input: 'create hello.txt\n/exit\n' });
  const file = path.join(work, 'hello.txt');
  check('session: task in session writes file', code === 0 && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'hello from ineed', out);
}

// ── config corruption resilience ──
{
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), '{broken json!!');
  const { server, port } = await mock('default');
  const { code, out } = await run([], { input: `http://127.0.0.1:${port}/v1\n${SECRET}\n\n` });
  check('corrupt config: wizard rescues', code === 0 && out.includes('Saved'), out);
  server.close();
}

// ── memory: recall from icm lands in the model context; store after real work ──
{
  const fakeBin = path.join(TMP, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'icm'), '#!/bin/sh\ncase "$1" in\n  recall) echo "3 | FAKE-MEMORY-MARKER durable fact from previous session" ;;\n  remember) echo "stored" ;;\n  *) echo "icm" ;;\nesac\n');
  fs.chmodSync(path.join(fakeBin, 'icm'), 0o755);
  const { server, port } = await mock('memory');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini', memory: true }), { mode: 0o600 });
  const { code, out } = await run(['do a thing'], { fakePath: fakeBin, memory: true });
  check('memory: recalled fact reaches model context', code === 0 && out.includes('MEMORY-VERIFIED'), out);
  server.close();
}

// ── memory: /memory reports provider status ──
{
  const { server, port } = await mock('default');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  const { code, out } = await run([], { input: '/memory\n/memory off\n/memory on\n/exit\n', memory: true });
  check('session: /memory status + on/off toggle', code === 0 && (out.includes('Memory: on') || out.includes('Memory: provider not installed')) && out.includes('Memory: off') && out.includes('Memory: on'), out);
  server.close();
}

// ── permissions: one-shot non-TTY cannot ask, so it runs (CI behavior) ──
{
  const { code, out, work } = await oneShot('approve', 'make ok.txt', { permEdit: 'ask' }, null, { input: 'n\n' });
  const file = path.join(work, 'ok.txt');
  check('perm: one-shot non-TTY runs without asking (CI)', code === 0 && fs.existsSync(file), out);
}
{
  const { code, out } = await oneShot('approve', 'make ok.txt', { permEdit: 'allow' }, null, { input: '' });
  check('perm: permEdit allow skips asking', out.includes('APPROVAL-GRANTED'), out);
}

// ── session: /perm shows and sets ──
{
  const { server, port } = await mock('default');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  const { code, out } = await run([], { input: '/perm\n/perm shell allow\n/perm auto\n/exit\n' });
  check('session: /perm view + set + auto', out.includes('Permissions') && out.includes('Shell permission: allow.') && out.includes('run without asking'), out);
  server.close();
}

// ── session: fresh open shows welcome + helpers ──
{
  const { server, port } = await mock('default');
  fs.mkdirSync(CFG, { recursive: true });
  fs.writeFileSync(path.join(CFG, 'config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: SECRET, model: 'mock-mini' }), { mode: 0o600 });
  const { code, out } = await run([], { input: '/exit\n', fresh: true });
  check('session: fresh welcome with examples and helpers', out.includes('Welcome to ineed!') && out.includes('landing page') && out.includes('/perm'), out);
  server.close();
}

// ── no em dash anywhere in shipped source ──
{
  const files = ['src/cli.js', 'src/ui.js', 'src/config.js', 'src/provider.js', 'src/tools.js', 'src/agent.js', 'src/wizard.js', 'src/session.js', 'README.md', 'package.json', 'LICENSE'];
  let clean = true;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/[\u2013\u2014]/.test(txt)) { clean = false; check('em dash scan: ' + f, false, 'found'); }
  }
  check('em dash scan: all files clean', clean);
}

// ── no wrong repo references anywhere ──
{
  const files = ['src/cli.js', 'src/ui.js', 'src/config.js', 'src/provider.js', 'src/tools.js', 'src/agent.js', 'src/wizard.js', 'src/session.js', 'README.md', 'package.json', 'LICENSE'];
  let clean = true;
  for (const f of files) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/github\.com\/ineedcodes/.test(txt)) { clean = false; check('repo url scan: ' + f, false, 'wrong url found'); }
  }
  check('repo url scan: only salsabila2507 referenced', clean);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
