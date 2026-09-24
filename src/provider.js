// provider.js: OpenAI-compatible chat + model listing. Timeout and cancellation built in.

const HTTP_TIMEOUT = 120_000;
const BODY_TIMEOUT = 120_000;   // headers can arrive fast while the body stalls

// interruptible sleep, optionally telling the user why it is waiting
function sleep(ms, signal, onNote) {
  onNote?.();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => done();
    const timer = setTimeout(done, ms);
    if (signal?.aborted) return done();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// read a body with a deadline: a connection that stops mid-body must not hang
async function readBody(res, signal) {
  if (!res.body) return await res.text();
  const ctrl = new AbortController();
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay, { once: true });
  const timer = setTimeout(() => ctrl.abort(), BODY_TIMEOUT);
  try {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let raw = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
      if (raw.length > 8_000_000) { try { await reader.cancel(); } catch {} break; }
    }
    raw += dec.decode();
    return raw;
  } catch (err) {
    return '';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

async function request(url, opts, signal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, HTTP_TIMEOUT);
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay, { once: true });
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (signal?.aborted) {
      // signal.reason can be a string (abort('steer')) that undici rethrows as-is
      const e = new Error('stopped by user');
      e.stopped = true;
      e.reason = signal.reason;
      throw e;
    }
    if (timedOut) throw new Error('request timed out after 120s');
    throw new Error(`cannot reach ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

// A gateway can sit in front of several upstream providers and list them as
// "provider/model". With modelAlias set, the user sees one namespace instead
// ("ineed/model"), and the real id goes back on the wire when the request is
// sent. Providers without modelAlias are listed exactly as they send themselves.
const aliasCache = new Map();

export function buildModelAlias(ids, alias) {
  const map = new Map();
  const list = [];
  for (const id of ids) {
    const slash = id.indexOf('/');
    const prefix = slash > 0 ? id.slice(0, slash) : '';
    const name = slash > 0 ? id.slice(slash + 1) : id;
    const shown = prefix && alias ? `${alias}/${name}` : id;
    const kept = map.get(shown);
    if (kept !== undefined) {
      // two upstreams share this name: the gateway's own namespace wins
      if (prefix !== alias && kept.startsWith(`${alias}/`)) continue;
      map.set(shown, id);
      continue;
    }
    map.set(shown, id);
    list.push(shown);
  }
  return { list, map };
}

function realModelId(cfg) {
  const want = String(cfg.model ?? '');
  return aliasCache.get(cfg.baseUrl)?.get(want) ?? want;
}

// A one-shot run never lists models, so the map would be empty and the shown
// name would go out as-is. Fetch the list once, lazily, when the configured
// model looks like an alias. A failure here just sends the name unchanged.
const aliasWarm = new Map();
async function warmAlias(cfg, signal) {
  const alias = String(cfg.modelAlias ?? '').trim();
  if (!alias) return;
  if (aliasCache.has(cfg.baseUrl)) return;
  if (!String(cfg.model ?? '').startsWith(`${alias}/`)) return;
  if (!aliasWarm.has(cfg.baseUrl)) {
    aliasWarm.set(cfg.baseUrl, (async () => {
      try { await fetchModels({ ...cfg, model: '' }, signal); } catch {}
    })().finally(() => aliasWarm.delete(cfg.baseUrl)));
  }
  await aliasWarm.get(cfg.baseUrl);
}

export async function fetchModels(cfg, signal) {
  const headers = { accept: 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await request(`${cfg.baseUrl}/models`, { headers }, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status} on GET /models${httpHint(res.status)}`);
  const data = await res.json();
  const ids = [...new Set((data.data ?? []).map(m => m.id).filter(Boolean))];
  const alias = String(cfg.modelAlias ?? '').trim();
  if (!alias) {
    aliasCache.delete(cfg.baseUrl);
    return ids;
  }
  const { list, map } = buildModelAlias(ids, alias);
  aliasCache.set(cfg.baseUrl, map);
  return list;
}

// human guidance for the status codes a hosted gateway actually returns
function httpHint(status) {
  if (status === 401 || status === 403) return ' - API key rejected or not allowed here. Replace it: /provider add <name>, or check your key.';
  if (status === 402) return ' - this key is out of credit. Top up in the provider dashboard, or use another provider: /provider';
  if (status === 404) return ' - API address not found. Check the base URL, it usually ends with /v1. See: /config';
  if (status === 429) return ' - too many requests. Wait a moment and try again.';
  if (status >= 500) return ' - the provider is having trouble. Try again in a little while.';
  return '';
}

// the server may tell us exactly when to come back (Retry-After: seconds or
// HTTP-date). Honoring it beats guessing a backoff; capped so a bad header
// can never hang a task for minutes.
const MAX_RETRY_DELAY = 60_000;

function retryAfterMs(res) {
  const h = res?.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(MAX_RETRY_DELAY, secs * 1000);
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(MAX_RETRY_DELAY, date - Date.now()));
  return null;
}

// a 400 that names the model is almost always a stale model id after a provider
// switch, so say the one action that fixes it
function modelHint(status, text) {
  if (!/model/i.test(String(text))) return '';
  if (status === 404 || status === 400 || status === 422) {
    return ' - this model does not exist at that provider. Switch: /provider (the list is pulled again), or /model';
  }
  return '';
}

export async function chat(cfg, messages, tools, signal, onDelta, onNote) {
  await warmAlias(cfg, signal);
  const body = { model: realModelId(cfg), messages, temperature: 0.2 };
  if (cfg.reasoning === 'high') body.reasoning_effort = 'high';
  if (cfg.stream === true) body.stream = true;
  if (tools?.length) body.tools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  // transient failures (network errors, 429, 5xx) get retries with backoff; other HTTP answers do not
  const ATTEMPTS = 4;
  let res;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let threw = null;
    try {
      res = await request(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
    } catch (err) {
      threw = err;
    }
    const retryable = threw || [429, 500, 502, 503, 504].includes(res?.status);
    if (!retryable || attempt === ATTEMPTS || signal?.aborted) {
      if (threw) throw threw;
      break;
    }
    if (threw || res) {
      // honor Retry-After when the gateway sends it, back off otherwise
      const delay = (!threw && res?.status === 429 ? retryAfterMs(res) : null)
        ?? Math.min(15_000, 1500 * attempt * attempt);
      // the wait must be interruptible: Ctrl+C during a 15s sleep used to hang
      await sleep(delay, signal, () => {
        const why = threw ? threw.message : 'HTTP ' + res.status;
        onNote?.(`retry ${attempt + 1}/${ATTEMPTS} in ${Math.round(delay / 1000)}s (${String(why).slice(0, 80)})`);
      });
      if (signal?.aborted) throw Object.assign(new Error('stopped by user'), { stopped: true, reason: signal.reason });
    }
  }
  if (!res.ok) {
    const text = (await readBody(res, signal)).slice(0, 4000);
    // provider does not know reasoning_effort: retry once without it
    if (body.reasoning_effort && (res.status === 400 || res.status === 422)) {
      delete body.reasoning_effort;
      delete body.stream;
      const retry = await request(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
      if (!retry.ok) {
        const t = (await readBody(retry, signal)).slice(0, 200);
        throw new Error(`HTTP ${retry.status}: ${t}${httpHint(retry.status)}${modelHint(retry.status, t)}`);
      }
      return parseMessage(await readCompletion(retry, signal));
    }
    // provider does not stream: fall back to a plain call instead of failing
    if (body.stream && (res.status === 400 || res.status === 404 || res.status === 422)) {
      delete body.stream;
      res = await request(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
      if (!res.ok) {
        const t = (await readBody(res, signal)).slice(0, 200);
        throw new Error(`HTTP ${res.status}: ${t}${httpHint(res.status)}${modelHint(res.status, t)}`);
      }
      return parseMessage(await readCompletion(res, signal));
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}${httpHint(res.status)}${modelHint(res.status, text)}`);
  }
  if (body.stream) return readStream(res, onDelta);
  return parseMessage(await readCompletion(res, signal));
}

// SSE stream: accumulate content and tool_calls, emit text deltas as they arrive.
// The HTTP timeout only guards until the headers; a hung connection mid-stream
// would otherwise wait forever, so a stall deadline cancels the reader instead.
const STREAM_STALL_MS = 90_000;

async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = [];
  let usage = null;
  let role = 'assistant';
  let stalled = false;
  let stall = null;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => {
      stalled = true;
      try { reader.cancel(); } catch {}   // pending read() resolves done
    }, STREAM_STALL_MS);
  };
  armStall();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armStall();
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.usage) usage = ev.usage;
        const d = ev.choices?.[0]?.delta;
        if (!d) continue;
        if (d.role) role = d.role;
        if (d.content) {
          content += d.content;
          onDelta?.(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? 0;
          toolCalls[i] ??= { id: tc.id ?? ('call_' + i), type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  } finally {
    clearTimeout(stall);
  }
  // a stalled stream can end mid tool-call: the partial JSON must never be
  // returned as if it were a complete message. "(timed out)" puts it in the
  // retryable class the session's recovery prompt already understands
  if (stalled) throw new Error('stream stalled: no data for 90s (timed out)');
  // Some providers ignore stream:true and answer with one plain JSON body. The
  // stream reader then sees no data: lines and would report an empty answer,
  // which used to look like a finished task with no output. Parse it instead.
  if (!content && !toolCalls.length && !usage && buffer.trim().startsWith('{')) {
    try {
      return parseMessage(JSON.parse(buffer));
    } catch (err) {
      if (err && /unusable reply/.test(String(err.message))) throw err;
    }
  }
  const msg = { role, content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  if (usage) msg._usage = { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 };
  // a stream that produced neither text nor a tool call is not a usable answer
  if (!content && !toolCalls.length) {
    throw new Error('Provider sent an unusable reply (the stream carried no message). Try /model, or turn streaming off with "stream": false in the config.');
  }
  return msg;
}

// Several OpenAI-compatible routers (local proxies, gateways) answer with an SSE
// body even when stream was not requested. JSON.parse then dies with
// "Unexpected non-whitespace character after JSON", which looks like a broken
// key. Read the body as text and rebuild the message from the chunks instead.
// first complete JSON value in the text, respecting strings and escapes
function firstJsonObject(text) {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function readCompletion(res, signal) {
  const raw = await readBody(res, signal);
  // Some routers append stream leftovers to a normal JSON body, with or without
  // a newline ("...}{\n\ndata: [DONE]" or "...}data: [DONE]"), and others stream
  // the whole reply even when stream was not requested. Take the first complete
  // JSON value; if there is none, assemble the answer from the SSE chunks.
  const trailer = raw.search(/data:|event:/);
  if (trailer > 0) {
    const head = raw.slice(0, trailer).trim();
    try { return JSON.parse(head); } catch {}
    const obj = firstJsonObject(head);
    if (obj) { try { return JSON.parse(obj); } catch {} }
  }
  if (trailer === -1) return JSON.parse(raw);
  let content = '';
  let role = 'assistant';
  const toolCalls = new Map();
  let usage = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    const at = t.indexOf('data:');
    if (at < 0) continue;
    const payload = t.slice(at + 5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    if (j.usage) usage = j.usage;
    const d = j.choices?.[0]?.delta ?? {};
    if (d.role) role = d.role;
    if (d.content) content += d.content;
    for (const tc of d.tool_calls ?? []) toolCalls.set(tc.index ?? toolCalls.size, { ...(toolCalls.get(tc.index) ?? {}), ...tc });
  }
  const message = { role, content };
  if (toolCalls.size) message.tool_calls = [...toolCalls.values()];
  return { choices: [{ message }], usage };
}

function parseMessage(json) {
  const choice = json?.choices?.[0];
  // a 200 with no usable choice used to look like a finished task with no
  // output; say what actually came back instead
  if (!choice || !choice.message || (!choice.message.content && !(choice.message.tool_calls ?? []).length)) {
    const hint = Array.isArray(json?.choices) ? 'the server returned no message' : 'the response was not in the OpenAI format';
    throw new Error(`Provider sent an unusable reply (${hint}). Try /model, or check the provider with: ineed provider use <name>`);
  }
  const msg = choice.message;
  // surface token usage when the provider returns it (OpenAI-style usage block)
  if (json.usage) msg._usage = {
    input: json.usage.prompt_tokens ?? 0,
    output: json.usage.completion_tokens ?? 0
  };
  return msg;
}
