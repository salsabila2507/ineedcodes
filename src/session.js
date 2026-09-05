// session.js: interactive chat TUI. Fixed logo header, scrolling chat area, fixed status + input footer.
// Falls back to a plain REPL (same commands) when stdout is not a TTY, so tests and pipes keep working.

import * as readline from 'node:readline';
import { clearConfig, normalize, saveConfig } from './config.js';
import { runObjective, pushTurn } from './agent.js';
import { fetchModels } from './provider.js';
import { makeInput, bold, dim, red, green, yellow, cyan, gray, trunc, BANNER, logo, box, startSpinner, VERSION, RULE, userBubble, screen } from './ui.js';
import { wizard } from './wizard.js';
import { getMemoryProvider, ICMAdapter } from './memory.js';
import { mcpConfigured } from './mcp.js';

const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

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

export async function startSession(cfg, { fresh = false } = {}) {
  const state = normalize(cfg);
  let history = [];
  let busy = false;
  let activeRun = null;
  let mode = state.mode;
  let lastSigint = 0;
  let closed = false;
  const approved = new Set(); // session-wide "always allow" grants
  const pendingLines = [];

  const TUI = process.stdout.isTTY && !process.env.NO_COLOR;

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

  async function runTask(input) {
    busy = true;
    let lastStreamed = '';
    if (TUI) tuiUserLine(input);
    let spinner = null;
    const stopSpinner = () => { spinner?.stop(); spinner = null; };
    try {
      const res = await runObjective(state, input, process.cwd(), history, {
        onMemoryStart: () => { stopSpinner(); spinner = startSpinner('recalling memory'); },
        onMemoryEnd: () => stopSpinner(),
        onThinkingStart: () => { stopSpinner(); spinner = startSpinner('thinking'); },
        onThinkingEnd: () => stopSpinner(),
        onWorkStart: label => { stopSpinner(); spinner = startSpinner(label || 'working'); },
        onWorkEnd: () => stopSpinner(),
        onTool: (name, input2) => { stopSpinner(); say(cyan('  ● ' + name) + gray(' ' + trunc(JSON.stringify(input2), 90))); },
        onResult: out => { say(gray('    ' + trunc(out, 110))); },
        onText: t => { stopSpinner(); lastStreamed = t; },
        onTodos: list => {
          stopSpinner();
          const mark = s => s === 'completed' ? green('✔') : s === 'in_progress' ? cyan('▸') : dim('○');
          say(box([bold('To-do'), ...list.map(t => '  ' + mark(t.status) + ' ' + t.content)]));
        },
        onAgentStart: (id, input) => { stopSpinner(); say(cyan('  ◆ spawn ' + id) + gray(` role=${input.role ?? '?'} task=${trunc(String(input.objective ?? ''), 70)}`)); },
        onAgentEnd: (id, r) => { stopSpinner(); say((r.status === 'completed' ? green('  ◆ ' + id + ' done') : yellow('  ◆ ' + id + ' ' + r.status)) + gray(' ' + trunc(String(r.summary ?? '').replaceAll('\n', ' '), 90))); },
        onMCP: names => { if (names.length) say(dim('  MCP tools available: ' + names.join(', '))); },
        onMCPResult: (name, out) => { say(gray('    mcp result: ' + trunc(out, 100))); },
        onApprove: async (cat, name, input2) => {
          stopSpinner();
          say(yellow('  ⚠ approval needed') + ' ' + cyan(name) + gray(' ' + trunc(JSON.stringify(input2), 80)));
          const a = await ask('     [y] once · [a] always for ' + cat + ' · [n] no: ');
          const c = a.trim().toLowerCase();
          if (c === 'a' || c === 'always') { approved.add(cat); say(dim('     always allowed for this session.')); return 'always'; }
          if (c === 'y' || c === 'yes') return true;
          say(dim('     denied.'));
          return false;
        },
        approved,
        onRunStart: c => { activeRun = c; },
        onRunEnd: () => { activeRun = null; stopSpinner(); }
      });
      history = pushTurn(history, input, res);
      stopSpinner();
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
      say('  ' + cyan('/config') + '   show provider config (key hidden)');
      say('  ' + cyan('/memory') + '   memory status, /memory on|off to toggle');
      say('  ' + cyan('/mcp') + '     list MCP servers and their tools');
      say('  ' + cyan('/clear') + '    forget this conversation');
      say('  ' + cyan('/setup') + '    redo provider setup');
      say('  ' + cyan('/reset') + '    clear saved config');
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
    if (busy) { pendingLines.push(input); return; }
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
