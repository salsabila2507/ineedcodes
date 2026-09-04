// agent.js: the loop. objective -> reason -> tool call -> observe real result -> repeat -> verify -> report.

import { chat } from './provider.js';
import { TOOLS, runTool, shellRun, isDestructive } from './tools.js';
import { trunc, gray, cyan, dim } from './ui.js';
import { getMemoryProvider } from './memory.js';

export const MAX_STEPS = 30;
export const MAX_HISTORY_CHARS = 30_000;
export const MAX_TURNS = 40;

const SYSTEM = `You are ineed, an autonomous terminal agent on the user's machine.
Rules:
- Use the tools to do real work. Never invent output. Every success claim needs evidence from a tool result.
- Prefer targeted edits (edit_file) over full rewrites (write_file). Work only inside the current folder.
- Never push to remotes or delete data without being asked.
- Destructive commands are always blocked. Ask the user to run those themselves.
- Some actions need user approval. A tool result starting with "Denied" means the user said no: do not retry the same call, explain what you wanted instead.
- For objectives with 3 or more steps, keep a checklist with the todo tool and update statuses as you go (in_progress for what you are doing now).
- When the objective is done, verify it (run the tests, read the file back, whatever proves it), then reply with the final result in this shape:
  What changed, what you ran, the evidence you saw.`;

export function trimHistory(history) {
  let start = history.length, total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    total += (history[i].content?.length ?? 0) + 24;
    if (total > MAX_HISTORY_CHARS) break;
    start = i;
  }
  return history.slice(start);
}

export async function runObjective(cfg, objective, cwd, history, hooks = {}) {
  const ctrl = new AbortController();
  hooks.onRunStart?.(ctrl);
  const plan = cfg.mode === 'plan';
  const tools = plan ? TOOLS.filter(t => t.allowedInPlan) : TOOLS;
  const canAsk = typeof hooks.onApprove === 'function';

  // recall durable memory before meaningful work (rule 12/15: MemoryProvider abstraction)
  const memory = getMemoryProvider(cfg);
  let recalled = '';
  if (memory) {
    hooks.onMemoryStart?.();
    try { recalled = await memory.recall(objective); } catch { recalled = ''; }
    hooks.onMemoryEnd?.(recalled);
  }

  const messages = [
    {
      role: 'system',
      content: `${SYSTEM}\nWorking directory: ${cwd}\nMode: ${plan ? 'plan (read only, suggest what to change, do not change anything)' : 'build'}`
        + (recalled ? `\nRelevant memory from previous sessions with this user (durable facts, may be stale):\n${recalled}` : '')
    },
    ...trimHistory(history),
    { role: 'user', content: objective }
  ];
  const changed = new Set();
  const ran = [];
  const todos = [];
  let answer = '';
  let lastShown = '';
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (ctrl.signal.aborted) break;
      let msg;
      try {
        hooks.onThinkingStart?.();
        msg = await chat(cfg, messages, tools, ctrl.signal);
        hooks.onThinkingEnd?.();
      } catch (err) {
        hooks.onThinkingEnd?.();
        if (ctrl.signal.aborted) break;
        throw err;
      }
      messages.push(msg);
      if (msg.content && msg.content !== lastShown) {
        hooks.onText?.(msg.content);
        lastShown = msg.content;
        answer = msg.content;
      }
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        // task finished: store durable knowledge only when something actually changed
        if (memory && answer && (changed.size > 0 || ran.length > 0) && !ctrl.signal.aborted) {
          try {
            await memory.store(`project ${cwd}: ${objective.slice(0, 150)} -> ${answer.slice(0, 300)}`);
          } catch {}
        }
        return { answer, changed: [...changed], ran, todos: [...todos], aborted: false };
      }
      for (const call of calls) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
        hooks.onTool?.(call.function?.name, input);
        let result;
        if (call.function?.name === 'shell') {
          if (plan) result = { output: 'Refused: plan mode is read only. Switch to build mode with /build.' };
          else if (isDestructive(String(input.command ?? ''))) {
            result = { output: 'Refused: that command is destructive. Run it yourself if you are sure.' };
          } else if (cfg.permShell !== 'allow' && !hooks.approved?.has('shell')) {
            const verdict = canAsk ? await hooks.onApprove('shell', 'shell', input) : true; // cannot ask: CI-style allow
            if (verdict === 'always') hooks.approved?.add('shell');
            if (!verdict) {
              result = { output: 'Denied: the user did not approve this shell command.' };
            }
          }
          if (!result) {
            hooks.onWorkStart?.(`running: ${trunc(String(input.command ?? ''), 60)}`);
            result = await shellRun(String(input.command ?? ''), cwd, ctrl.signal);
            hooks.onWorkEnd?.();
            ran.push(String(input.command ?? '').slice(0, 120));
          }
        } else {
          if (plan && !TOOLS.find(t => t.name === call.function?.name)?.allowedInPlan) {
            result = { output: 'Refused: plan mode is read only. Switch to build mode with /build.' };
          } else if (call.function?.name === 'todo') {
            const list = Array.isArray(input.todos) ? input.todos : [];
            todos.splice(0, todos.length, ...list.slice(0, 50).map(t => ({
              content: String(t.content ?? '').slice(0, 200),
              status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending'
            })));
            hooks.onTodos?.([...todos]);
            result = { output: `Todo list updated (${todos.filter(t => t.status === 'completed').length}/${todos.length} done).` };
          } else {
            const name = call.function?.name;
            const isEdit = ['write_file', 'edit_file', 'delete_file'].includes(name);
            let allowedNow = true;
            if (isEdit && cfg.permEdit !== 'allow' && !hooks.approved?.has('edit')) {
              const verdict = canAsk ? await hooks.onApprove('edit', name, input) : true; // cannot ask: CI-style allow
              if (verdict === 'always') hooks.approved?.add('edit');
              allowedNow = Boolean(verdict);
            }
            result = allowedNow ? runTool(name, input, cwd) : { output: `Denied: the user did not approve ${name}.` };
            if (allowedNow && !plan && isEdit
              && !/^(Refused|Error|Denied)/.test(String(result.output))) {
              changed.add(String(input.path ?? ''));
            }
          }
        }
        hooks.onResult?.(result.output);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result.output).slice(0, 20_000) });
      }
    }
  } finally {
    hooks.onRunEnd?.();
  }
  const stopped = ctrl.signal.aborted;
  return { answer, changed: [...changed], ran, todos: [...todos], aborted: true, stopped };
}

export function pushTurn(history, objective, result) {
  history.push({ role: 'user', content: objective }, { role: 'assistant', content: result.answer });
  if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);
  return history;
}
