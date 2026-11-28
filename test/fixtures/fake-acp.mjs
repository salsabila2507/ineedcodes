#!/usr/bin/env node
// fake-acp.mjs: a spec-faithful ACP v1 agent for tests (JSON-RPC 2.0, one message per line).
// FAKE_ACP_LOG: append every message received, one JSON per line.
// FAKE_ACP_MODE: "auth" requires authenticate (agent-type method) before session/new;
// "noauth" answers auth_required with no methods; "v2" answers protocolVersion 2.
import * as fs from 'node:fs';
import * as readline from 'node:readline';

const mode = process.env.FAKE_ACP_MODE ?? '';
const toolTitle = process.env.FAKE_ACP_TOOL_TITLE || 'Write notes.txt';
// FAKE_ACP_PID: where to write this process id, so a test can prove it was shut down
if (process.env.FAKE_ACP_PID) fs.writeFileSync(process.env.FAKE_ACP_PID, String(process.pid));
const log = m => { if (process.env.FAKE_ACP_LOG) fs.appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(m) + '\n'); };
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
let authed = mode !== 'auth' && mode !== 'noauth';
let nextId = 1000;
let model = 'fake-1';
const models = () => [{ value: 'fake-1', name: 'Fake One' }, { value: 'fake-2', name: 'Fake Two' }];
const waiting = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });

readline.createInterface({ input: process.stdin }).on('line', async line => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.method === undefined) {
    const r = waiting.get(msg.id);
    waiting.delete(msg.id);
    return r?.(msg);
  }
  const reply = result => send({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: mode === 'v2' ? 2 : 1,
        agentCapabilities: { loadSession: false },
        agentInfo: { name: 'fake-acp', version: '0.0.1' },
        authMethods: mode === 'auth' ? [{ id: 'fake-login', name: 'Fake login', description: 'pretend sign-in' }] : []
      });
    case 'authenticate':
      if (msg.params?.methodId !== 'fake-login') return fail(-32602, 'unknown method');
      authed = true;
      return reply({});
    case 'session/new':
      if (!authed) return fail(-32000, 'Authentication required');
      return reply({
        sessionId: 'sess_fake_1',
        models: { currentModelId: model, availableModels: models() },
        configOptions: [{
          id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
          options: models()
        }]
      });
    case 'session/prompt': {
      const sid = msg.params.sessionId;
      if (mode === 'double') {
        const opts = [{ optionId: 'y', name: 'Allow', kind: 'allow_once' }, { optionId: 'n', name: 'Reject', kind: 'reject_once' }];
        const both = await Promise.all(['one', 'two'].map(title => ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: title, title }, options: opts })));
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BOTH:' + both.map(b => b.result?.outcome?.optionId ?? b.result?.outcome?.outcome).join(',') } });
        return reply({ stopReason: 'end_turn' });
      }
      const text = msg.params.prompt.map(b => b.text).join('');
      // an unrelated notification the client must not answer
      send({ jsonrpc: '2.0', method: '_fake/ping', params: {} });
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ECHO:' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text } });
      update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: toolTitle, kind: 'edit', status: 'pending' });
      const answer = await ask('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 'call_1', title: toolTitle, kind: 'edit' },
        options: [
          { optionId: 'ok-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'ok-always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'no-once', name: 'Reject', kind: 'reject_once' }
        ]
      });
      const outcome = answer.result?.outcome;
      const picked = outcome?.outcome === 'selected' ? outcome.optionId : 'cancelled';
      const allowed = picked === 'ok-once' || picked === 'ok-always';
      update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', title: toolTitle, status: allowed ? 'completed' : 'failed' });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' PERM:' + picked } });
      // a client call ineed does not support must get a JSON-RPC error back
      const fsAnswer = await ask('fs/read_text_file', { sessionId: sid, path: '/etc/hostname' });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' FS:' + (fsAnswer.error?.code ?? 'ok') } });
      return reply({ stopReason: 'end_turn' });
    }
    case 'session/set_config_option':
      model = msg.params.value;
      return reply({ configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: models() }] });
    case 'session/cancel':
      return;
    default:
      if (msg.id !== undefined) fail(-32601, 'Method not found');
  }
});
