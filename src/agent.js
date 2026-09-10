// agent.js: the loop. objective -> reason -> tool call -> observe real result -> repeat -> verify -> report.

import { chat } from './provider.js';
import { TOOLS, runTool, shellRun, isDestructive, GIT_TOOL_DEFS, runGitTool } from './tools.js';
import { fetchUrl, webSearch } from './web.js';
import { PROC_TOOL_DEFS, runProcTool } from './processes.js';
import { trunc, gray, cyan, dim } from './ui.js';
import { getMemoryProvider } from './memory.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { listSkills } from './skills.js';

function loadProjectInstructions(cwd) {
  const out = [];
  for (const rel of ['AGENTS.md', path.join('.ineedcodes', 'instructions.md')]) {
    try {
      const txt = fs.readFileSync(path.join(cwd, rel), 'utf8').trim();
      if (txt) out.push(`--- ${rel} ---\n${txt.slice(0, 4_000)}`);
    } catch {}
  }
  return out.join('\n\n').slice(0, 8_000);
}

export const MAX_STEPS = 30;
export const MAX_HISTORY_CHARS = 30_000;
export const MAX_TURNS = 40;

const SYSTEM = `You are ineed, an autonomous terminal agent on the user's machine.
Rules:
- Use the tools to do real work. Never invent output. Every success claim needs evidence from a tool result.
- Prefer targeted edits (edit_file) over full rewrites (write_file). Work only inside the current folder.
- Scope discipline: never explore outside the working folder (no listing the home directory, no scanning drives, no cloning repos) unless the user explicitly names those paths in the current objective. If the task needs it, ask first.
- Prefer answering from what you already know: questions like "udah?", "done?", or status checks get a direct answer from the conversation. Only call tools when new facts are genuinely needed.
- Never push to remotes or delete data without being asked.
- Destructive commands are always blocked. Ask the user to run those themselves.
- Your replies go straight to a terminal: never use markdown formatting (no **bold**, no ## headers, no tables, no emojis as decoration). Plain sentences and simple "- " bullets only.
- Explain to match the user's depth preference (short: results only; normal: what changed and why; deep: also the reasoning and trade-offs).
- Suggest "boost" (isolated git-worktree run) when a task involves major refactoring, repeated failed fixes, or architecture changes, by telling the user to run /boost. Do not start it yourself.
- Some actions need user approval. A tool result starting with "Denied" means the user said no: do not retry the same call, explain what you wanted instead.
- For objectives with 3 or more steps, keep a checklist with the todo tool and update statuses as you go (in_progress for what you are doing now).
- A "[steer from the user, newer than the objective]" message is a live steer: it is newer than the original objective. Adapt to it immediately; if it changes direction, change course without redoing finished work.
- When building web pages or UI: commit to one coherent style; restrained palette (1 primary, 1 accent, neutral background); a real Google Fonts pairing; no emoji as icons (use inline SVG); cursor-pointer on clickables; visible focus states; text contrast at least 4.5:1; responsive at 375, 768, 1024, 1440px; respect prefers-reduced-motion; avoid generic AI purple/pink gradients and default template blue.
- When the objective is done, verify it (run the tests, read the file back, whatever proves it), then reply with the final result in this shape:
  What changed, what you ran, the evidence you saw.`;

export function trimHistory(history) {
  let start = history.length, total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    total += (history[i].content?.length ?? 0) + 24;
    if (total > MAX_HISTORY_CHARS) break;
    start = i;
  }
  // never start inside a tool-call block: some providers reject a history whose
  // first message is a tool result (or an assistant turn whose calls were cut)
  while (start < history.length && history[start].role !== 'user') start++;
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
      worker: { id: spec.id, role: roleName, prompt: role.prompt },
      modelOverride: cfg.models?.[roleName] ?? cfg.models?.worker ?? null
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
  let ctrl = new AbortController();
  hooks.onRunStart?.(ctrl);
  const plan = cfg.mode === 'plan';
  const depth = extra.depth ?? 0;
  let tools = plan ? TOOLS.filter(t => t.allowedInPlan) : [...TOOLS, SPAWN_TOOL];
  // first-class git wrappers (read ones always, mutating ones gated by permEdit)
  tools.push(...GIT_TOOL_DEFS.filter(t => plan ? !t.mutating : true));
  // background process tools (build mode only)
  if (!plan) tools.push(...PROC_TOOL_DEFS);
  if (extra.toolFilter) tools = tools.filter(t => (extra.toolFilter).includes(t.name));
  const canAsk = typeof hooks.onApprove === 'function';
  const roleCfg = extra.modelOverride ? { ...cfg, model: extra.modelOverride } : cfg;

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
  const projectInstructions = extra.worker ? '' : loadProjectInstructions(cwd);
  const depthNote = extra.worker ? '' : (cfg.explain === 'short' ? '\nAnswer style: short. Give results, skip explanations unless asked.' : cfg.explain === 'deep' ? '\nAnswer style: deep. Include reasoning, trade-offs, and what you ruled out.' : '');
  const skills = extra.worker ? [] : listSkills(cwd, objective);
  const skillsBlock = skills.length ? `\nInstalled skills (follow a skill's instructions when the user invokes it by name or clearly asks for what it does):\n${skills.map(s => `- ${s.name} (${s.scope}): ${s.description}`).join('\n')}` : '';
  // developer mode (jungle keyword present) has no extra hoops: a named gated
  // skill activates on mention alone; the builtin humanizer still wants an ask
  if (skills.some(s => s.gated)) hooks.onNote?.('developer mode aktif - gunakan dengan bijak, hanya untuk target yang kamu miliki izinnya');
  const invokedSkill = !extra.worker
    ? skills.find(s => s.name
      && new RegExp(`\\b${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(objective)
      && (s.gated || /humanize|skill|pakai|gunakan|use/i.test(objective)))
    : null;
  const messages = [
    {
      role: 'system',
      content: `${workerPrefix ? workerPrefix + '\n' : ''}${SYSTEM}${depthNote}\nWorking directory: ${cwd}\nMode: ${plan ? 'plan (read only, suggest what to change, do not change anything)' : 'build'}`
        + (recalled ? `\nRelevant memory from previous sessions with this user (durable facts, may be stale):\n${recalled}` : '')
        + (projectInstructions ? `\nProject instructions for this repository (follow them):\n${projectInstructions}` : '')
        + skillsBlock
    },
    ...trimHistory(history),
    { role: 'user', content: objective + (invokedSkill
      ? `\n\n[skill ${invokedSkill.name} activated] ${invokedSkill.instructions.slice(0, 2_000)}`
        + (invokedSkill.gated ? '\n[developer skill: authorized security testing only - gunakan dengan bijak]' : '')
      : '') }
  ];
  const changed = new Set();
  const ran = [];
  const todos = [];
  const usage = { input: 0, output: 0 };
  let answer = '';
  let lastShown = '';
  // notes typed mid-task, injected at safe points; a steer can also interrupt an in-flight call
  const drainSteerInto = () => {
    const steer = hooks.drainSteer?.() ?? [];
    for (const s of steer) {
      messages.push({ role: 'user', content: `[steer from the user, newer than the objective] ${s}` });
    }
    if (steer.length) hooks.onSteer?.(steer);
    return steer;
  };
  let steerRestarts = 0;
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // a steer abort must not kill the task: restart the call with the note included
      if (ctrl.signal.aborted && ctrl.signal.reason === 'steer') {
        drainSteerInto();
        hooks.onNote?.('applying your steer, restarting the call');
        ctrl = new AbortController();
        hooks.onRunStart?.(ctrl);
      }
      if (ctrl.signal.aborted) break;
      drainSteerInto();
      let msg;
      try {
        hooks.onThinkingStart?.();
        msg = await chat(roleCfg, messages, tools, ctrl.signal, hooks.onDelta);
        hooks.onThinkingEnd?.();
      } catch (err) {
        hooks.onThinkingEnd?.();
        const steerInterrupt = ctrl.signal.aborted && (ctrl.signal.reason === 'steer' || err.reason === 'steer');
        if (steerInterrupt && steerRestarts < 20) {
          steerRestarts++;
          drainSteerInto();
          hooks.onNote?.('applying your steer, restarting the call');
          ctrl = new AbortController();
          hooks.onRunStart?.(ctrl);
          step--; // redo this step with the steer included
          continue;
        }
        if (ctrl.signal.aborted) break;
        throw err;
      }
      messages.push(msg);
      if (msg._usage) { usage.input += msg._usage.input; usage.output += msg._usage.output; hooks.onUsage?.({ ...usage }); }
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
        return { answer, changed: [...changed], ran, todos: [...todos], usage: { ...usage }, aborted: false };
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
        // a stop must cut through: never execute queued tools after an abort
        if (ctrl.signal.aborted) break;
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch {}
        hooks.onTool?.(call.function?.name, input);
        let result;
        let resultRendered = false;   // some hooks render the result themselves
        // enforce the role's tool allowlist at execution time, not just listing time
        if (extra.toolFilter && !extra.toolFilter.includes(call.function?.name)) {
          result = { output: `Refused: your role is not allowed to use ${call.function?.name}. Report what you need instead.` };
        } else if (spawnResults.has(call.id)) {
          result = { output: workerResultText(spawnResults.get(call.id)) };
        } else if (call.function?.name === 'spawn_agent') {
          result = { output: 'Refused: workers cannot spawn more agents.' };
        } else if (mcpMap.has(call.function?.name)) {
          const m = mcpMap.get(call.function?.name);
          result = await mcpManager.call(m.server, m.tool, input);
          hooks.onMCPResult?.(call.function?.name, result.output);
          resultRendered = true;   // onResult below must not render it twice
        } else if (call.function?.name?.startsWith('git_')) {
          const def = GIT_TOOL_DEFS.find(t => t.name === call.function?.name);
          if (plan) {
            // plan mode is read only, and the read-only git wrappers are part of
            // its tool list: status/diff/log/branch execute, mutations refuse
            result = def && !def.mutating
              ? runGitTool(call.function?.name, input, cwd)
              : { output: 'Refused: plan mode is read only. Switch to build mode with /build.' };
          } else if (!def) {
            result = { output: `Unknown tool: ${call.function?.name}` };
          } else {
            let allowedNow = !def.mutating || cfg.permEdit === 'allow' || hooks.approved?.has('edit');
            if (!allowedNow && canAsk) {
              const verdict = await hooks.onApprove('edit', call.function?.name, input);
              if (verdict === 'always') hooks.approved?.add('edit');
              allowedNow = Boolean(verdict);
            }
            result = allowedNow ? runGitTool(call.function?.name, input, cwd) : { output: `Denied: the user did not approve ${call.function?.name}.` };
          }
        } else if (call.function?.name === 'fetch_url') {
          if (cfg.permNet === 'ask' && !hooks.approved?.has('net') && canAsk) {
            const verdict = await hooks.onApprove('net', 'fetch_url', input);
            if (verdict === 'always') hooks.approved?.add('net');
            if (!verdict) result = { output: 'Denied: the user did not approve network access.' };
          }
          if (!result) result = await fetchUrl(input.url);
        } else if (call.function?.name === 'web_search') {
          if (cfg.permNet === 'ask' && !hooks.approved?.has('net') && canAsk) {
            const verdict = await hooks.onApprove('net', 'web_search', input);
            if (verdict === 'always') hooks.approved?.add('net');
            if (!verdict) result = { output: 'Denied: the user did not approve network access.' };
          }
          if (!result) result = await webSearch(cfg, input.query);
        } else if (call.function?.name?.startsWith('process_')) {
          if (plan) result = { output: 'Refused: plan mode is read only.' };
          else {
            const def = PROC_TOOL_DEFS.find(t => t.name === call.function?.name);
            if (!def) {
              result = { output: `Unknown tool: ${call.function?.name}` };
            } else {
            let allowedNow = !def.mutating || cfg.permShell === 'allow' || hooks.approved?.has('shell');
            if (!allowedNow && canAsk) {
              const verdict = await hooks.onApprove('shell', call.function?.name, input);
              if (verdict === 'always') hooks.approved?.add('shell');
              allowedNow = Boolean(verdict);
            }
            result = allowedNow ? runProcTool(call.function?.name, input, cwd) : { output: `Denied: the user did not approve ${call.function?.name}.` };
            }
          }
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
            const isEdit = ['write_file', 'edit_file', 'delete_file', 'copy_file', 'move_file'].includes(name);
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
              // humanizer pass: prose files only (html/md/txt), code never touched (rule 21)
              if (name === 'write_file' && cfg.humanize !== false) {
                const abs = path.resolve(cwd, String(input.path ?? ''));
                try {
                  const { humanizeFile } = await import('./humanize.js');
                  const hr = await humanizeFile(cfg, abs, ctrl.signal, { skipModel: false });
                  if (hr.changed) hooks.onNote?.(`humanized copy in ${String(input.path)}`);
                } catch {}
              }
            }
          }
        }
        if (!resultRendered) hooks.onResult?.(result.output);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result.output).slice(0, 20_000) });
      }
    }
  } finally {
    // MCP servers are per-objective child processes: without this every task
    // leaks them until the CLI exits.
    if (depth === 0) mcpManager?.killAll();
    hooks.onRunEnd?.();
  }
  const stopped = ctrl.signal.aborted;
  // distinguish a user stop from the step limit: the report line differs
  // ("Stopped" vs "ran out of steps"), and a step-limit stop is retryable
  return {
    answer, changed: [...changed], ran, todos: [...todos],
    usage: { ...usage },
    aborted: true,
    stopped,
    stopReason: stopped ? 'user' : 'step_limit'
  };
}

export function pushTurn(history, objective, result) {
  history.push({ role: 'user', content: objective }, { role: 'assistant', content: result.answer });
  if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);
  return history;
}
