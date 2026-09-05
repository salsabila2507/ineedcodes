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

// ── multi-agent: roles, task packets, worker execution ──
const ROLES = {
  research: {
    readonly: true,
    tools: ['list_files', 'read_file', 'search_text', 'todo'],
    prompt: 'You are a research worker. Gather facts and report them. Change nothing.'
  },
  review: {
    readonly: true,
    tools: ['list_files', 'read_file', 'search_text', 'todo'],
    prompt: 'You are a review worker. Inspect the code for correctness, bugs, and quality. Report findings, change nothing.'
  },
  test: {
    readonly: false,
    tools: ['list_files', 'read_file', 'search_text', 'shell', 'todo'],
    prompt: 'You are a test worker. Run the relevant tests or commands and report the evidence. Do not modify source files.'
  },
  implement: {
    readonly: false,
    tools: null, // all tools
    prompt: 'You are an implementation worker. Make the change the lead asked for, verify it works, and report what you did.'
  },
  debug: {
    readonly: false,
    tools: null, // all tools
    prompt: 'You are a debugging worker. Find the root cause, fix it if you can, and report cause plus evidence.'
  }
};

let workerSeq = 0;

function workerResultText(r) {
  const files = r.files?.length ? ` files: ${r.files.join(', ')};` : '';
  const cmds = r.commands?.length ? ` ran ${r.commands.length} command(s);` : '';
  return `Worker ${r.id} [${r.status}]: ${String(r.summary).slice(0, 800)}.${files}${cmds}`;
}

async function runWorker(cfg, spec, cwd, depth, hooks) {
  const roleName = ROLES[spec.input.role] ? spec.input.role : 'research';
  const role = ROLES[roleName];
  const objective = String(spec.input.objective ?? '')
    + (spec.input.context ? `\nContext from lead agent: ${String(spec.input.context).slice(0, 1_000)}` : '');
  try {
    const res = await runObjective(cfg, objective, cwd, [], {}, {
      depth: depth + 1,
      toolFilter: role.tools,
      worker: { id: spec.id, role: roleName, prompt: role.prompt }
    });
    return { id: spec.id, role: roleName, status: res.aborted ? 'incomplete' : 'completed', summary: res.answer || '(no output)', files: res.changed, commands: res.ran };
  } catch (err) {
    return { id: spec.id, role: roleName, status: 'failed', summary: err.message, files: [], commands: [] };
  }
}

const SPAWN_TOOL = {
  name: 'spawn_agent',
  description: 'Spawn a focused sub-agent worker. Roles: research (read only), review (read only), test (runs commands, does not edit), implement (edits), debug (finds and fixes). Read-only workers can run in parallel.',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: Object.keys(ROLES) },
      objective: { type: 'string', description: 'the exact task for this worker' },
      context: { type: 'string', description: 'relevant context: files, errors, constraints' }
    },
    required: ['role', 'objective']
  },
  allowedInPlan: true
};

export async function runObjective(cfg, objective, cwd, history, hooks = {}, extra = {}) {
  const ctrl = new AbortController();
  hooks.onRunStart?.(ctrl);
  const plan = cfg.mode === 'plan';
  const depth = extra.depth ?? 0;
  let tools = plan ? TOOLS.filter(t => t.allowedInPlan) : [...TOOLS, SPAWN_TOOL];
  if (extra.toolFilter) tools = tools.filter(t => (extra.toolFilter).includes(t.name));
  const canAsk = typeof hooks.onApprove === 'function';

  // MCP: load configured servers once per top-level objective, expose their tools
  let mcpManager = null;
  const mcpMap = new Map();
  if (depth === 0 && !plan && cfg.mcp !== false) {
    try {
      const { McpManager, mcpConfigured } = await import('./mcp.js');
      if (mcpConfigured()) {
        mcpManager = new McpManager();
        const errors = await mcpManager.loadFromConfig();
        errors.forEach(e => hooks.onText?.(dim(e)));
        const mcpTools = await mcpManager.allTools();
        const names = new Set(tools.map(t => t.name));
        for (const t of mcpTools) {
          if (!names.has(t.name)) { tools.push(t); mcpMap.set(t.name, t.mcp); names.add(t.name); }
        }
        hooks.onMCP?.(mcpTools.map(t => t.name));
      }
    } catch {}
  }

  // recall durable memory before meaningful work (rule 12/15: MemoryProvider abstraction)
  const memory = extra.skipMemory ? null : getMemoryProvider(cfg);
  let recalled = '';
  if (memory) {
    hooks.onMemoryStart?.();
    try { recalled = await memory.recall(objective); } catch { recalled = ''; }
    hooks.onMemoryEnd?.(recalled);
  }

  const workerPrefix = extra.worker ? `You are ${extra.worker.id} (${extra.worker.role} worker) spawned by the lead agent. ${extra.worker.prompt}\n` : '';
  const messages = [
    {
      role: 'system',
      content: `${workerPrefix ? workerPrefix + '\n' : ''}${SYSTEM}\nWorking directory: ${cwd}\nMode: ${plan ? 'plan (read only, suggest what to change, do not change anything)' : 'build'}`
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
      // spawn_agent pre-pass: read-only workers run in parallel (max 4), writers sequentially
      const spawnResults = new Map();
      const spawnCalls = calls.filter(c => c.function?.name === 'spawn_agent');
      if (spawnCalls.length && depth === 0) {
        const specs = spawnCalls.map(c => {
          let input = {};
          try { input = JSON.parse(c.function?.arguments || '{}'); } catch {}
          const role = ROLES[input.role] ? input.role : 'research';
          return { call: c, input, role, id: `${role}-${++workerSeq}` };
        });
        const runOne = async s => {
          hooks.onAgentStart?.(s.id, s.input);
          const r = await runWorker(cfg, s, cwd, depth, hooks);
          hooks.onAgentEnd?.(s.id, r);
          spawnResults.set(s.call.id, r);
        };
        const readonly = specs.filter(s => ROLES[s.role].readonly).slice(0, 4);
        const writers = specs.filter(s => !ROLES[s.role].readonly);
        for (let i = 0; i < readonly.length; i += 4) {
          await Promise.all(readonly.slice(i, i + 4).map(runOne));
        }
        for (const s of writers) await runOne(s);
      }

      for (const call of calls) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
        hooks.onTool?.(call.function?.name, input);
        let result;
        if (spawnResults.has(call.id)) {
          result = { output: workerResultText(spawnResults.get(call.id)) };
        } else if (call.function?.name === 'spawn_agent') {
          result = { output: 'Refused: workers cannot spawn more agents.' };
        } else if (mcpMap.has(call.function?.name)) {
          const m = mcpMap.get(call.function?.name);
          result = await mcpManager.call(m.server, m.tool, input);
          hooks.onMCPResult?.(call.function?.name, result.output);
        } else if (call.function?.name === 'shell') {
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
          if (plan && !tools.find(t => t.name === call.function?.name)) {
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
