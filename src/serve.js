// serve.js: run ineed away from the terminal. One serial task queue feeds two
// doors: a local HTTP API an app can talk to, and a Telegram bot. Both use the
// saved config, the same folder, and the same model as the session.

import http from 'node:http';
import { runObjective } from './agent.js';

// Tasks run one at a time: two agents editing the same folder at once is how
// work gets lost. Everything queued keeps its place and reports when it is done.
export function createHost(cfg, { cwd, onEvent = () => {} } = {}) {
  let busy = false;
  let queued = 0;
  let tail = Promise.resolve();
  let current = null;
  let stopping = false;
  const listeners = new Set();
  const emit = event => {
    onEvent(event);
    for (const l of listeners) { try { l(event); } catch {} }
  };
  const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };

  const submit = text => {
    const task = String(text ?? '').trim();
    if (stopping) return Promise.resolve({ answer: 'Stopped before it started.', changed: [] });
    const run = tail.then(async () => {
      queued--;
      if (!task) return { answer: '' };
      // a shutdown drops whatever was queued: starting it would be half a task
      if (stopping) return { answer: 'Stopped before it started.', changed: [] };
      busy = true;
      emit({ type: 'started', text: task });
      try {
        const r = await runObjective(cfg, task, cwd, [], {
          onRunStart: c => { current = c; },
          onRunEnd: () => { current = null; },
          onNote: note => emit({ type: 'note', text: String(note) }),
          onTool: name => emit({ type: 'tool', name }),
          onText: t => emit({ type: 'text', text: String(t) }),
          drainSteer: () => []
        }, {});
        emit({ type: 'done', text: r.answer ?? '', changed: r.changed ?? [], aborted: Boolean(r.aborted) });
        return r;
      } catch (err) {
        // a task can fail after it already wrote files or ran commands: say what
        // it managed to do, so a retry does not silently repeat that work
        const changed = err?.partial?.changed ?? [];
        emit({ type: 'error', text: String(err?.message ?? err), changed, partial: true });
        return { answer: 'Error: ' + String(err?.message ?? err), changed, partial: true };
      } finally {
        busy = false;
      }
    });
    queued++;
    tail = run.catch(() => {});
    return run;
  };

  // Ctrl+C during a remote task must stop the work, not just this process: a
  // shell command runs in its own process group and would keep going otherwise
  const stop = async (waitMs = 10_000) => {
    stopping = true;
    try { current?.abort?.(); } catch {}
    await Promise.race([tail.catch(() => {}), new Promise(r => setTimeout(r, waitMs))]);
  };

  return { submit, subscribe, stop, status: () => ({ busy, queued, cwd, model: cfg?.model ?? '' }) };
}

// ── HTTP: how an app (a phone, a small web UI) talks to a running ineed ──

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export function startHttp(host, { port = 7777, token = '', hostname = '127.0.0.1' } = {}) {
  const listeners = new Set();   // one unsubscribe per open event stream

  // A tokenless server still must not take work from a web page someone has
  // open: a browser sends Origin (and a non-JSON content type sails through a
  // CORS preflight), so both are refused. curl, apps and scripts send neither.
  const hasBody = req => req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
  const fromBrowser = req => Boolean(req.headers.origin)
    || (hasBody(req) && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? '')));

  const allowed = req => {
    if (!token) return !fromBrowser(req);
    const auth = String(req.headers.authorization ?? '');
    return auth === 'Bearer ' + token;
  };

  const hostAllowed = req => {
    const name = String(req.headers.host ?? '').replace(/:\d+$/, '');
    return !name || ['127.0.0.1', 'localhost', '[::1]'].includes(name);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!hostAllowed(req)) return json(res, 421, { ok: false, error: 'wrong host' });
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, version: 1, ...host.status() });
    }
    if (!allowed(req)) return json(res, 401, { ok: false, error: token ? 'missing or wrong token' : 'this call did not come from a local app: send JSON without a browser Origin, or start the server with --token' });

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('event: ready\ndata: ' + JSON.stringify(host.status()) + '\n\n');
      const push = event => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      const off = host.subscribe(push);
      listeners.add(off);
      const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
      // the response closing is what means the app went away; req 'close' fires
      // as soon as the request body ends, which would drop the stream at once
      res.on('close', () => { listeners.delete(off); off(); clearInterval(beat); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/task') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 100_000) req.destroy();
      });
      req.on('end', () => {
        let text = '';
        try { text = String(JSON.parse(body || '{}').text ?? ''); } catch { return json(res, 400, { ok: false, error: 'body must be JSON: {"text": "..."}' }); }
        if (!text.trim()) return json(res, 400, { ok: false, error: 'text is required' });
        host.submit(text);
        json(res, 202, { ok: true, accepted: text.trim().slice(0, 120) });
      });
      return;
    }
    json(res, 404, { ok: false, error: 'try POST /task, GET /events or GET /health' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      const actual = server.address();
      resolve({
        port: typeof actual === 'object' && actual ? actual.port : port,
        close: () => new Promise(done => { for (const off of listeners) off(); listeners.clear(); server.close(() => done()); })
      });
    });
  });
}

// ── Telegram: the same queue, reachable from a phone chat ──

export const TELEGRAM_TEXT = [
  'ineed is connected to this chat.',
  '',
  'Send a task as a normal message and it runs in the folder this bot was started in.',
  '  /status  what it is doing right now',
  '  /help    this message'
].join('\n');

const chunk = (text, size = 3800) => {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
};

export async function startTelegram(host, { token, chats = [], apiBase = process.env.INEED_TELEGRAM_API || 'https://api.telegram.org', signal } = {}) {
  if (!token) throw new Error('no Telegram bot token. Set it with: ineed telegram --token <token> (or telegramToken in config)');
  const allow = chats.map(String).filter(Boolean);
  const call = async (method, params) => {
    const res = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description ?? res.status}`);
    return data.result;
  };
  const reply = async (chatId, text) => {
    for (const part of chunk(text)) await call('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true });
  };

  let offset = 0;
  let running = true;
  const stop = () => { running = false; };

  const handle = async update => {
    const msg = update.message ?? update.edited_message;
    const text = String(msg?.text ?? '').trim();
    const chatId = String(msg?.chat?.id ?? '');
    if (!text || !chatId) return;
    // an empty allowlist allows nobody: a bot that answers every stranger runs
    // shell commands for them
    if (!allow.includes(chatId)) {
      return reply(chatId, `This chat (id ${chatId}) is not allowed yet. Add it to telegramChats to use ineed here.`);
    }
    if (/^\/(start|help)\b/.test(text)) return reply(chatId, TELEGRAM_TEXT);
    if (/^\/status\b/.test(text)) {
      const s = host.status();
      return reply(chatId, [s.busy ? 'Working now.' : 'Ready.', `folder: ${s.cwd}`, `model: ${s.model || '(not set)'}`, s.queued ? `queued: ${s.queued}` : ''].filter(Boolean).join('\n'));
    }
    if (/^\/stop\b/.test(text)) return reply(chatId, 'Use the terminal to stop a running task; this chat cannot interrupt it.');
    await reply(chatId, 'Working on it: ' + text.slice(0, 200));
    // the queue serializes the work; this loop must keep reading updates while
    // it runs, or /status and other chats would wait for the task to finish
    host.submit(text).then(async r => {
      const body = String(r.answer ?? '').trim() || (r.aborted ? 'Stopped.' : 'Done.');
      const changed = Array.isArray(r.changed) && r.changed.length ? '\n\n' + (r.partial ? 'changed before the error: ' : 'changed: ') + r.changed.slice(0, 12).join(', ') : '';
      // plain text only: model output can contain anything, and markdown or HTML
      // parsing would turn that into a broken or spoofed message
      await reply(chatId, `> ${text.slice(0, 200)}\n\n${body}${changed}`).catch(() => {});
    }).catch(() => {});
  };

  (async () => {
    while (running) {
      let updates = [];
      try {
        updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      } catch (err) {
        if (signal?.aborted) return;
        // a bad token or no network: wait, then try again instead of dying
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      if (!Array.isArray(updates)) { await new Promise(r => setTimeout(r, 1000)); continue; }
      for (const u of updates) {
        offset = Math.max(offset, Number(u.update_id) + 1);
        await handle(u).catch(() => {});
      }
    }
  })();

  return { stop, allowedChats: allow };
}
