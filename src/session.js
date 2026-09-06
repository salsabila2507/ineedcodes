// session.js: interactive chat TUI. Fixed logo header, scrolling chat area, fixed status + input footer.
// Falls back to a plain REPL (same commands) when stdout is not a TTY, so tests and pipes keep working.

import * as readline from 'node:readline';
import { clearConfig, normalize, saveConfig } from './config.js';
import { runObjective, pushTurn } from './agent.js';
import { fetchModels } from './provider.js';
import { makeInput, bold, dim, red, green, yellow, cyan, gray, trunc, BANNER, logo, box, startSpinner, VERSION, RULE, userBubble, screen } from './ui.js';
import { wizard } from './wizard.js';
import { getMemoryProvider, ICMAdapter } from './memory.js';
import { saveSession, listSessions, loadSession } from './sessions.js';
import * as boost from './boost.js';
import { mcpConfigured } from './mcp.js';
import { listSkills, findSkill } from './skills.js';

const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

// Context compaction (master prompt #32): when the saved conversation grows past the
// cap, summarize the oldest half into a factual checkpoint and drop the raw turns.
const COMPACT_CHARS = 24_000;
async function compactHistory(cfg, history, hooks = {}) {
  const size = history.reduce((n, m) => n + (m.content?.length ?? 0) + 24, 0);
  if (size < COMPACT_CHARS || history.length < 6) return history;
  const cut = Math.floor(history.length / 2);
  const old = history.slice(0, cut);
  const rest = history.slice(cut);
  const digest = old.map(m => `${m.role}: ${String(m.content ?? '').replaceAll('\n', ' ').slice(0, 160)}`).join('\n');
  try {
    const { chat } = await import('./provider.js');
    const msg = await chat({ ...cfg, reasoning: 'low' }, [
      { role: 'user', content: `Summarize this conversation into a factual checkpoint: goals, decisions, files touched, unresolved work. Max 12 lines. No prose flourish.\n---\n${digest.slice(0, 10_000)}` }
    ]);
    const summary = String(msg.content ?? '').trim();
    if (summary.length > 20) {
      hooks.onNote?.(`compacted ${cut} turns into a checkpoint (${(size / 1000).toFixed(0)}k -> ${((summary.length + rest.reduce((n, m) => n + (m.content?.length ?? 0) + 24, 0)) / 1000).toFixed(0)}k chars)`);
      return [{ role: 'user', content: '[conversation checkpoint] ' + summary }, { role: 'assistant', content: 'Checkpoint noted. Continuing from there.' }, ...rest];
    }
  } catch {}
  return history.slice(-10); // provider unavailable: keep the newest turns
}

function wrapLines(text, width) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    let line = raw;
    if (line === '') { out.push(''); continue; }
    while (plain(line).length > width) {
      let vis = 0, i = 0;
      while (i < line.length && vis < width) {
        if (line[i] === '\x1b') { while (i < line.length && line[i] !== 'm') i++; }
        else vis++;
        i++;
      }
      out.push(line.slice(0, i));
      line = line.slice(i);
    }
    out.push(line);
  }
  return out;
}

export async function startSession(cfg, { fresh = false, resume = null } = {}) {
  const state = normalize(cfg);
  let history = resume?.length ? [...resume] : [];
  let busy = false;
  let activeRun = null;
  let mode = state.mode;
  let lastSigint = 0;
  let closed = false;
  const approved = new Set(); // session-wide "always allow" grants
  const pendingLines = [];
  const steerQueue = [];      // notes typed while a task runs, injected mid-task

  const TUI = process.stdout.isTTY && !process.env.NO_COLOR;
  let sessionId = null;
  let lastBoost = null;

  // ONE readline, ONE line dispatcher for the whole session
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let handleRef = null;
  const ask = makeInput(rl, l => handleRef?.(l));

  const say = TUI ? lines => tuiPrint(lines) : (lines => console.log(lines));

  function doExit() {
    closed = true;
    if (TUI) { screen.resetRegion(); screen.exit(); }
    console.log(dim('Goodbye.'));
    process.exit(0);
  }

  async function pickModel() {
    let models = [];
    try { models = await fetchModels(state); } catch (err) { say(red('   ' + err.message)); return; }
    if (models.length === 0) {
      say(yellow('   Server sent no list. Change model by editing ~/.ineedcodes/config.json'));
      return;
    }
    const list = models.slice(0, 5);
    say(dim(`   ${models.length} models available, showing ${list.length}. Type a number, or a full model id.`));
    list.forEach((m, i) => say(`   ${i + 1}. ${m}`));
    const pick = await ask('   Model: ');
    if (!pick) return;
    const idx = Number(pick);
    if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) Object.assign(state, normalize({ ...state, model: list[idx - 1] }));
    else Object.assign(state, normalize({ ...state, model: pick }));
    say(green('   Model: ' + state.model));
    if (TUI) drawStatus();
  }

  function hooksForRun(stopSpinner) {
    let spinner = null;
    const stop = () => { spinner?.stop(); spinner = null; };
    return {
      spinnerStop: stop,
      onMemoryStart: () => { stop(); spinner = startSpinner('recalling memory'); },
      onMemoryEnd: () => stop(),
      onThinkingStart: () => { stop(); spinner = startSpinner('thinking'); },
      onThinkingEnd: () => stop(),
      onWorkStart: label => { stop(); spinner = startSpinner(label || 'working'); },
      onWorkEnd: () => stop(),
      onTool: (name, input2) => { stop(); say(cyan('  ● ' + name) + gray(' ' + trunc(JSON.stringify(input2), 90))); },
      onResult: out => { say(gray('    ' + trunc(out, 110))); },
      onText: t => { stop(); },
      onTodos: list => {
        stop();
        const mark = s => s === 'completed' ? green('✔') : s === 'in_progress' ? cyan('▸') : dim('○');
        say(box([bold('To-do'), ...list.map(t => '  ' + mark(t.status) + ' ' + t.content)]));
      },
      onAgentStart: (id, input) => { stop(); say(cyan('  ◆ spawn ' + id) + gray(` role=${input.role ?? '?'} task=${trunc(String(input.objective ?? ''), 70)}`)); },
      onAgentEnd: (id, r) => { stop(); say((r.status === 'completed' ? green('  ◆ ' + id + ' done') : yellow('  ◆ ' + id + ' ' + r.status)) + gray(' ' + trunc(String(r.summary ?? '').replaceAll('\n', ' '), 90))); },
      onMCP: names => { if (names.length) say(dim('  MCP tools available: ' + names.join(', '))); },
      onMCPResult: (name, out) => { say(gray('    mcp result: ' + trunc(out, 100))); },
      onNote: note => { stop(); say(dim('  ◇ ' + note)); },
      drainSteer: () => steerQueue.splice(0),
      onSteer: list => { for (const s of list) say(yellow('  ↳ steer: ') + s); },
      onApprove: async (cat, name, input2) => {
        stop();
        say(yellow('  ⚠ approval needed') + ' ' + cyan(name) + gray(' ' + trunc(JSON.stringify(input2), 80)));
        const a = await ask('     [y] once · [a] this session · [s] always (save) · [n] no: ');
        const c = a.trim().toLowerCase();
        if (c === 's' || c === 'save') {
          approved.add(cat);
          if (cat === 'edit') Object.assign(state, normalize({ ...state, permEdit: 'allow' }));
          if (cat === 'shell') Object.assign(state, normalize({ ...state, permShell: 'allow' }));
          saveConfig(state);
          say(dim('     always allowed, saved to config. /perm safe to undo.'));
          return 'always';
        }
        if (c === 'a' || c === 'always') { approved.add(cat); say(dim('     always allowed for this session.')); return 'always'; }
        if (c === 'y' || c === 'yes') return true;
        say(dim('     denied.'));
        return false;
      },
      approved,
      onRunStart: c => { activeRun = c; },
      onRunEnd: () => { activeRun = null; stop(); }
    };
  }

  async function runTask(input) {
    busy = true;
    if (TUI) tuiUserLine(input);
    const hooks = hooksForRun();
    const stopSpinner = hooks.spinnerStop;
    try {
      const res = await runObjective(state, input, process.cwd(), history, hooks);
      history = pushTurn(history, input, res);
      stopSpinner();
      try { history = await compactHistory(state, history, { onNote: n => say(dim('  ◇ ' + n)) }); } catch {}
      try { sessionId = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
      if (res.aborted) {
        say(yellow('  ■ Stopped') + dim(' - partly done. Ask me to continue.'));
      } else {
        const rows = [green(bold('■ Done'))];
        if (res.changed?.length) rows.push(dim('  files: ') + res.changed.join(', '));
        if (res.answer) String(res.answer).split('\n').slice(0, 14).forEach(l => rows.push('  ' + l));
        else if (!res.changed?.length) rows.push(dim('  (no output)'));
        say(box(rows));
      }
    } catch (err) {
      stopSpinner();
      history = pushTurn(history, input, { answer: '(task failed: ' + err.message + ')' });
      try { sessionId = saveSession({ id: sessionId, cwd: process.cwd(), model: state.model, history }); } catch {}
      say(red('  ✗ ' + err.message) + dim('  context kept.'));
    } finally {
      busy = false;
      activeRun = null;
      stopSpinner();
      await afterTask();
    }
  }

  async function afterTask() {
    if (closed) return;
    // notes typed near the end that never reached the model become follow-up tasks
    if (steerQueue.length) pendingLines.unshift(...steerQueue.splice(0));
    if (TUI) { drawStatus(); scrollRegion(); return; }
    plainPrompt();
    while (!busy && !closed) {
      const next = pendingLines.shift();
      if (!next) break;
      await handle(next);
    }
  }

  const commands = {
    '/help': () => {
      say('  ' + cyan('/model') + '    pick a model from your provider');
      say('  ' + cyan('/plan') + '     plan mode: read only');
      say('  ' + cyan('/build') + '    build mode: real changes (default)');
      say('  ' + cyan('/reason') + '   toggle reasoning low/high');
      say('  ' + cyan('/perm') + '     permissions: /perm auto | /perm safe | /perm');
      say('  ' + cyan('/boost') + '    isolated git-worktree run: /boost <objective>');
      say('  ' + cyan('/config') + '   show provider config (key hidden)');
      say('  ' + cyan('/memory') + '   memory status, /memory on|off to toggle');
      say('  ' + cyan('/resume') + '   bring back a saved conversation');
      say('  ' + cyan('/skills') + '   list installed skills, /skills <name> shows one');
      say('  ' + cyan('/mcp') + '     list MCP servers and their tools');
      say('  ' + cyan('/humanizer') + ' natural-writing pass for pages and posts (on/off)');
      say('  ' + cyan('/clear') + '    forget this conversation');
      say('  ' + cyan('/setup') + '    redo provider setup');
      say('  ' + cyan('/reset') + '    clear saved config');
      say('  ' + cyan('/help') + '     this list. Type normally to work, steer mid-task anytime');
      say(dim('  while a task runs: your text is a live steer, /stop cancels it'));
      say('  ' + cyan('/exit') + '     quit');
    },
    '/config': () => {
      say(box([
        bold('Provider config') + dim('  ~/.ineedcodes/config.json'),
        dim('base URL') + '   ' + state.baseUrl,
        dim('model') + '      ' + state.model,
        dim('reasoning') + '  ' + state.reasoning,
        dim('mode') + '        ' + mode,
        dim('memory') + '      ' + (state.memory === false ? 'off' : 'on (icm)'),
        dim('edit perm') + '   ' + state.permEdit,
        dim('shell perm') + '  ' + state.permShell,
        dim('API key') + '     saved, hidden'
      ]));
    },
    '/clear': () => { history = []; say(dim('Conversation forgotten.')); }
  };

  async function handle(input) {
    if (!input) return;
    if (busy) {
      if (input === '/stop') { activeRun?.abort(); say(dim('  (stopping...')); return; }
      if (input.startsWith('/')) { pendingLines.push(input); return; }
      steerQueue.push(input);
      return;
    }
    if (['/exit', '/quit', 'exit', 'quit'].includes(input)) return doExit();
    if (input === '/help' || input === '?') return commands['/help']();
    if (input === '/config') return commands['/config']();
    if (input === '/clear') return commands['/clear']();
    if (input === '/model') { busy = true; try { await pickModel(); } finally { busy = false; } return afterTask(); }
    if (input === '/plan') { mode = 'plan'; Object.assign(state, normalize({ ...state, mode })); say(yellow('Plan mode: read only.')); if (TUI) drawStatus(); return; }
    if (input === '/build') { mode = 'build'; Object.assign(state, normalize({ ...state, mode })); say(green('Build mode: real changes.')); if (TUI) drawStatus(); return; }
    if (input === '/reason') {
      Object.assign(state, normalize({ ...state, reasoning: state.reasoning === 'high' ? 'low' : 'high' }));
      say(dim('Reasoning effort: ' + state.reasoning));
      if (TUI) drawStatus();
      return;
    }
    if (input === '/perm' || input.startsWith('/perm ')) {
      const arg = input.slice(5).trim();
      const apply = (pe, ps, msg) => {
        Object.assign(state, normalize({ ...state, permEdit: pe, permShell: ps }));
        saveConfig(state);
        say(green(msg));
        if (TUI) drawStatus();
      };
      if (arg === 'auto') return apply('allow', 'allow', 'Permissions: edits and shell run without asking.');
      if (arg === 'safe') return apply('ask', 'ask', 'Permissions: edits and shell ask first.');
      const parts = arg.split(/\s+/);
      if (parts[0] === 'edit' && ['allow', 'ask'].includes(parts[1])) {
        return apply(parts[1], state.permShell, `Edit permission: ${parts[1]}.`);
      }
      if (parts[0] === 'shell' && ['allow', 'ask'].includes(parts[1])) {
        return apply(state.permEdit, parts[1], `Shell permission: ${parts[1]}.`);
      }
      say(box([
        bold('Permissions'),
        dim('edit') + '   ' + state.permEdit + dim('  (write_file, edit_file, delete_file)'),
        dim('shell') + '   ' + state.permShell,
        dim('granted this session') + '  ' + ([...approved].join(', ') || 'none'),
        '',
        dim('/perm auto') + '   never ask (saved)',
        dim('/perm safe') + '   ask for edits and shell (saved)',
        dim('/perm edit allow|ask   /perm shell allow|ask')
      ]));
      return;
    }
    if (input === '/memory' || input.startsWith('/memory ')) {
      const arg = input.split(/\s+/)[1];
      if (arg === 'on' || arg === 'off') {
        Object.assign(state, normalize({ ...state, memory: arg === 'on' }));
        saveConfig(state);
        say(arg === 'on'
          ? green('Memory: on') + dim(' - durable facts are recalled before tasks and stored after real work.')
          : yellow('Memory: off') + dim(' - nothing is recalled or stored.'));
        if (TUI) drawStatus();
        return;
      }
      busy = true;
      const provider = getMemoryProvider(state);
      if (!provider) { say(yellow('Memory is off.') + dim(' Turn it on with /memory on')); busy = false; return afterTask(); }
      const ok = await ICMAdapter.available();
      say(ok ? green('Memory: on') + dim(` via ${provider.name}.`) : yellow('Memory: provider not installed.') + dim(' Install icm to enable.'));
      busy = false;
      return afterTask();
    }
    if (input === '/humanizer' || input.startsWith('/humanizer ')) {
      const arg = input.split(/\s+/)[1];
      if (arg === 'on' || arg === 'off') {
        Object.assign(state, normalize({ ...state, humanize: arg === 'on' }));
        saveConfig(state);
        say(arg === 'on'
          ? green('Humanizer: on') + dim(' - web pages and posts get a natural-writing pass after they are written.')
          : yellow('Humanizer: off') + dim(' - files are written exactly as the model produces them.'));
        return;
      }
      say(box([
        bold('Humanizer') + dim('  ' + (state.humanize === false ? 'off' : 'on')),
        dim('scope') + '      .html .htm .md .txt (web pages, posts, docs)',
        dim('never touches') + '  code, tags, attributes, URLs, JSON, technical values',
        dim('toggle') + '      /humanizer on | /humanizer off'
      ]));
      return;
    }
    if (input === '/boost cancel') {
      if (!lastBoost) { say(dim('No boost run to cancel.')); return; }
      const { dir, branch } = lastBoost;
      boost.cleanupBoost(process.cwd(), dir, branch);
      lastBoost = null;
      say(yellow('Boost worktree and branch removed.'));
      return;
    }
    if (input === '/boost' || input.startsWith('/boost ')) {
      const objective = input.slice(6).trim();
      if (!objective) {
        say(box([
          bold('Boost') + dim('  isolated execution in a git worktree'),
          dim('/boost <objective>') + '  run the task away from your tree, review, then merge',
          dim('/boost cancel') + '        remove the last boost worktree'
        ]));
        return;
      }
      busy = true;
      try {
        if (!boost.boostAvailable(process.cwd())) { say(yellow('Boost needs a git repository (with a commit).')); return; }
        const b = boost.startBoost(process.cwd());
        if (!b.ok) { say(red('Boost failed: ' + b.error)); return; }
        lastBoost = b;
        say(cyan(`  ⚡ boost ${b.branch}`) + dim(` worktree at ${b.dir}`));
        const res = await runObjective(state, objective, b.dir, [], { ...hooksForRun(), skipMemory: true });
        say((res.aborted ? yellow('  ■ Stopped') : green('  ⚡ Boost task done')) + dim(` in ${b.branch}`));
        boost.commitBoost(b.dir, 'boost: ' + objective.slice(0, 80));
        const d = boost.boostDiff(b.dir);
        if (d.files.length) {
          say(box([bold('Boost changes'), ...d.files.map(f => '  ' + f)]));
          const a = await ask(`   [y] merge into ${boost.currentBranch(process.cwd())} · [n] keep worktree: `);
          if (/^y/i.test(a.trim())) {
            const m = boost.mergeBoost(process.cwd(), b.branch);
            if (m.ok) { say(green('Merged into your branch.')); boost.cleanupBoost(process.cwd(), b.dir, b.branch); lastBoost = null; }
            else { say(red('Merge conflict, worktree kept: ' + m.out)); }
          } else {
            say(dim('Worktree kept: ' + b.dir + ' (' + b.branch + '). /boost cancel removes it.'));
          }
        } else {
          say(dim('No file changes came out of the boost run.'));
          boost.cleanupBoost(process.cwd(), b.dir, b.branch);
          lastBoost = null;
        }
      } catch (err) {
        say(red('  ✗ boost failed: ' + err.message));
      } finally {
        busy = false;
        await afterTask();
      }
      return;
    }
    if (input === '/skills' || input.startsWith('/skills ')) {
      const arg = input.slice(7).trim();
      if (arg) {
        const s = findSkill(arg, process.cwd());
        if (s) { say(box([bold(`Skill ${s.name}`) + dim(` (${s.scope})`), s.description, '', dim('Instructions:'), s.instructions.slice(0, 1_500)])); say(dim('Say "use ' + s.name + ' to ..." and the agent follows them.')); }
        else say(red(`No skill named ${arg}.`));
        return;
      }
      const all = listSkills(process.cwd());
      say(all.length ? all.map(s => `  ${cyan(s.name)} ${dim('(' + s.scope + ')')} ${s.description}`).join('\n') : yellow('No skills installed.'));
      return;
    }
    if (input === '/resume') {
      busy = true;
      const list = listSessions();
      if (!list.length) { say(yellow('No saved sessions yet.')); busy = false; return afterTask(); }
      list.slice(0, 5).forEach((s, i) => {
        const first = String(s.history?.find(m => m.role === 'user')?.content ?? '').replaceAll('\n', ' ').slice(0, 70);
        say(`   ${i + 1}. ${new Date(s.time).toLocaleString()} · ${Math.floor((s.history?.length ?? 0) / 2)} turns · ${first}`);
      });
      const pick = await ask('   Resume which? [1]: ');
      const n = Number(pick) || 1;
      const s = loadSession(list[n - 1]?.id);
      if (s?.history?.length) {
        history = s.history;
        sessionId = s.id;
        say(green(`Resumed ${Math.floor(s.history.length / 2)} turns. Continue where we left off.`));
      } else say(red('Could not load that session.'));
      busy = false;
      return afterTask();
    }
    if (input === '/mcp' || input === '/mcp reload') {
      if (!mcpConfigured()) {
        say(yellow('No MCP servers configured.') + dim(' Add them to ~/.ineedcodes/mcp.json, e.g.: {"context7":{"command":"npx","args":["-y","@upstash/context7-mcp"]}}'));
        return;
      }
      busy = true;
      try {
        const { McpManager } = await import('./mcp.js');
        const mgr = new McpManager();
        const errors = await mgr.loadFromConfig();
        for (const e of errors) say(red('  ✗ ' + e));
        const tools = await mgr.allTools();
        if (tools.length) {
          say(green(`  ${mgr.servers.size} MCP server(s), ${tools.length} tool(s):`));
          for (const t of tools) say('  ' + cyan(t.name) + gray(' ' + trunc(t.description, 90)));
        } else if (!errors.length) {
          say(yellow('  Servers connected but exposed no tools.'));
        }
        mgr.killAll();
      } catch (err) { say(red('  ✗ ' + err.message)); }
      busy = false;
      return afterTask();
    }
    if (input === '/setup' || input === '/reset') {
      clearConfig();
      say(dim('Config cleared. Running setup...'));
      busy = true;
      try {
        const c = await wizard(ask, { fromCommand: true });
        Object.assign(state, normalize(c));
        mode = state.mode;
        say(green('Ready. ' + state.model));
        if (TUI) { drawHeader(); drawStatus(); }
      } catch { return doExit(); }
      busy = false;
      return afterTask();
    }
    return runTask(input);
  }

  const plainPrompt = () => {
    rl.setPrompt(`\n[${mode}/${state.reasoning}] ${bold(green('ineed'))} ${green('❯')} `);
    rl.prompt();
  };

  const printWelcome = () => {
    const lines = fresh
      ? [
          green(bold('Welcome to ineed!')),
          '  You are all set: any OpenAI-compatible provider, any folder.',
          '  Type what you want in normal language, for example:',
          dim('    "buatkan landing page beranimasi di folder ini"'),
          dim('    "fix the failing tests and tell me what was wrong"'),
          dim('    "explain this repository like I am a beginner"'),
          '  ' + dim('Helpers: /help commands · /perm auto or safe · /model · /memory on|off')
        ]
      : [
          dim('Type what you want. /help for commands.')
            + (state.permEdit === 'ask' || state.permShell === 'ask' ? dim(' Edits and shell ask first: /perm auto to relax.') : '')
        ];
    for (const l of lines) say(l);
  };

  // ── plain REPL mode (pipes, tests, NO_COLOR) ──
  if (!TUI) {
    rl.on('SIGINT', () => {
      if (activeRun) { activeRun.abort(); console.log(dim('\nStopping...')); return; }
      const now = Date.now();
      if (now - lastSigint < 3000) return doExit();
      lastSigint = now;
      console.log(dim('\n(Ctrl+C again to exit)'));
      rl.prompt();
    });
    handleRef = handle;
    console.log(logo());
    console.log(BANNER() + dim(` · ${state.model} · ${process.cwd()}`));
    printWelcome();
    plainPrompt();
    return;
  }

  // ── full TUI mode ──
  const chatLines = [];           // completed chat lines (ANSI strings)
  let chatTop = 0, chatBot = 0;   // scroll region rows
  let statusRow = 0;

  function drawHeader() {
    const rows = 6;
    const lines = logo().split('\n');
    for (let i = 0; i < rows; i++) {
      screen.at(i + 1, 1);
      screen.clearLine();
      process.stdout.write(lines[i] ?? '');
    }
  }

  function drawStatus() {
    const cols = process.stdout.columns || 80;
    const left = ` ${bold(green('ineed'))} ${dim(`v${VERSION}`)}`;
    const mid = ` ${dim(state.model)}`;
    const right = ` ${mode === 'plan' ? yellow('plan') : green('build')} ${dim('/')} ${dim(state.reasoning)} ${dim('/')} ${state.memory === false ? dim('mem:off') : dim('mem:on')} `;
    screen.at(statusRow, 1);
    screen.clearLine();
    process.stdout.write(dim('─'.repeat(Math.max(0, cols - plain(left).length - plain(mid).length - plain(right).length))) + left + mid + right);
  }

  function scrollRegion() {
    screen.region(chatTop, chatBot);
    screen.at(chatBot, 1);
  }

  function redrawChat() {
    for (let i = chatTop; i <= chatBot; i++) {
      screen.at(i, 1);
      screen.clearLine();
    }
    screen.at(chatTop, 1);
    const vis = chatBot - chatTop + 1;
    const show = chatLines.slice(-vis);
    process.stdout.write(show.join('\r\n'));
    scrollRegion();
  }

  function tuiPrint(text) {
    for (const l of wrapLines(String(text), Math.max(10, (process.stdout.columns || 80) - 4))) chatLines.push(l);
    redrawChat();
  }

  function tuiUserLine(input) {
    for (const l of wrapLines(userBubble(input), Math.max(10, (process.stdout.columns || 80) - 4))) chatLines.push(l);
    redrawChat();
  }

  const layout = () => {
    const rows = process.stdout.rows || 24;
    const headerRows = 6;
    statusRow = rows - 1;
    chatTop = headerRows + 1;
    chatBot = statusRow - 1;
    screen.at(1, 1);
    process.stdout.write('\x1b[2J');
    drawHeader();
    redrawChat();
    drawStatus();
    scrollRegion();
  };

  rl.on('resize', layout);

  // keep Ctrl+Z from suspending us in raw mode: swallow the key, tell the user
  const origWrite = rl.write.bind(rl);
  rl.write = (d, key) => {
    if (key && key.ctrl && key.name === 'z') { tuiPrint(dim('  (Ctrl+Z is disabled here. Use /exit, or Ctrl+C twice.)')); return; }
    return origWrite(d, key);
  };

  rl.on('SIGINT', () => {
    if (activeRun) { activeRun.abort(); return; }
    const now = Date.now();
    if (now - lastSigint < 3000) return doExit();
    lastSigint = now;
  });

  handleRef = handle;

  screen.enter();
  layout();
  printWelcome();
  scrollRegion();
}
