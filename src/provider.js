// provider.js: OpenAI-compatible chat + model listing. Timeout and cancellation built in.

const HTTP_TIMEOUT = 120_000;

async function request(url, opts, signal) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, HTTP_TIMEOUT);
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay, { once: true });
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (signal?.aborted) { const e = new Error('stopped by user'); e.stopped = true; throw e; }
    if (timedOut) throw new Error('request timed out after 120s');
    throw new Error(`cannot reach ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

export async function fetchModels(cfg, signal) {
  const headers = { accept: 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const res = await request(`${cfg.baseUrl}/models`, { headers }, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status} on GET /models`);
  const data = await res.json();
  const ids = (data.data ?? []).map(m => m.id).filter(Boolean);
  return [...new Set(ids)];
}

export async function chat(cfg, messages, tools, signal, onDelta) {
  const body = { model: cfg.model, messages, temperature: 0.2 };
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
      const delay = Math.min(15_000, 1500 * attempt * attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  if (!res.ok) {
    const text = await res.text();
    // provider does not know reasoning_effort: retry once without it
    if (body.reasoning_effort && (res.status === 400 || res.status === 422)) {
      delete body.reasoning_effort;
      delete body.stream;
      const retry = await request(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
      if (!retry.ok) throw new Error(`HTTP ${retry.status}: ${(await retry.text()).slice(0, 200)}`);
      return parseMessage(await retry.json());
    }
    // provider does not stream: fall back to a plain call instead of failing
    if (body.stream && (res.status === 400 || res.status === 404 || res.status === 422)) {
      delete body.stream;
      res = await request(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, signal);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return parseMessage(await res.json());
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (body.stream) return readStream(res, onDelta);
  return parseMessage(await res.json());
}

// SSE stream: accumulate content and tool_calls, emit text deltas as they arrive.
async function readStream(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolCalls = [];
  let usage = null;
  let role = 'assistant';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
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
  const msg = { role, content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  if (usage) msg._usage = { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 };
  return msg;
}

function parseMessage(json) {
  const msg = json.choices?.[0]?.message ?? { role: 'assistant', content: '', tool_calls: [] };
  // surface token usage when the provider returns it (OpenAI-style usage block)
  if (json.usage) msg._usage = {
    input: json.usage.prompt_tokens ?? 0,
    output: json.usage.completion_tokens ?? 0
  };
  return msg;
}
