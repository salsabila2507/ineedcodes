<div align="center">

<img src="https://raw.githubusercontent.com/salsabila2507/ineedcodes/main/assets/logo.svg" alt="ineed" width="480">

**Your terminal, now autonomous.**

You say what you want. ineed reads the files, writes the code, runs the commands, checks the output, and fixes what breaks.

[![npm](https://img.shields.io/npm/v/ineedcodes.svg)](https://www.npmjs.com/package/ineedcodes)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/ineedcodes.svg)](https://nodejs.org)
[![stars](https://img.shields.io/github/stars/salsabila2507/ineedcodes?style=social)](https://github.com/salsabila2507/ineedcodes)

</div>

## Install

```bash
npm install -g ineedcodes
```

Works on Linux, macOS, and Windows (PowerShell and cmd). Needs Node.js 20 or newer.

## First open

```
$ ineed

Welcome to ineed - let's connect you to an AI provider. You only do this once.
Any OpenAI-compatible API works: OpenAI, OmniRoute, LM Studio, Ollama, vLLM, and more.

1. API base URL (example: https://api.openai.com/v1): https://api.openai.com/v1
2. API key (input hidden): ********
   Connected. 41 models available.
3. Model id (Enter = gpt-4o-mini):
   Works. Replied: OK
   Saved to ~/.ineedcodes/config.json. You will not be asked again.
```

Pick your provider, paste your key, choose a model. Done once, never asked again.

## Providers

Save as many OpenAI-compatible providers as you want and switch between them instantly:

```bash
ineed provider                     # list saved providers, active one marked with *
ineed provider add local           # guided setup for a new provider (tests it, saves it)
ineed provider use openai          # switch provider
ineed provider remove local        # drop one
```

Inside a session: `/provider` lists them, `/provider <name>` switches, `/provider add` sets one up, `/provider remove <name>` drops it. To only point the current provider at another endpoint: `/config baseurl http://localhost:11434/v1`.

For scripts, CI, or a one-off run, environment variables override the config file entirely (no config needed):

```bash
INEED_BASE_URL=https://api.openai.com/v1 INEED_API_KEY=sk-... INEED_MODEL=gpt-4o-mini ineed "fix the tests"
```

## Use

```bash
ineed                          # session
ineed "fix the build errors"   # one-shot task
```

Then just talk.

```
ineed › fix the failing tests and tell me what was wrong
ineed › build me a telegram bot that echoes messages, test it, then commit
ineed › explain this repository like I am a beginner
```

The agent decides what it needs: list files, read code, search, edit, run shell commands, verify the result, and report back with evidence.

## Session shortcuts

| command | what it does |
|---|---|
| `/model` | pick a model from your provider |
| `/provider` | list, switch, add or remove API providers |
| `/plan` | read-only mode, the agent suggests but changes nothing |
| `/build` | default mode, the agent makes real changes |
| `/reason` | toggle reasoning effort low/high |
| `/perm` | permission modes: `/perm auto`, `/perm safe` |
| `/memory` | durable memory status, `/memory on\|off` |
| `/mcp` | list MCP servers and their tools |
| `/setup` | reconfigure the active provider (keeps the others) |
| `/config` | numbered settings menu: permissions, work mode, answer length, memory |
| `/status` | what is active right now: model, provider, permissions, token use |
| `/depth` | answer length: `/depth short\|normal\|deep` |
| `/humanizer` | natural wording pass for html/md copy, on or off |
| `/theme` | color theme |
| `/init` | scan this folder and write an AGENTS.md notes file |
| `/clear` | forget this conversation (asks before deleting the saved copy) |
| `/exit` | quit |

Shortcuts are optional. Normal language always works, and the common ones work
without the slash: type `status`, `provider`, `model`, `help`, or `plan` and they
run like the command above.

## Safety, in plain words

- The agent works **inside the folder you started it in**. Files outside it are refused.
- `.env`, `.ssh/`, and `.git/` are never read or written, so keys cannot leak into the model.
- Destructive commands (`rm -rf`, `git reset --hard`, `git clean`, force push, `curl ... | sh`) are blocked. You run those yourself.
- Edits and shell commands ask first, unless you allow them for the session: `[y] once`, `[a] allow everything this run`, `[n] no`.
- One-shot runs (`ineed "task"`) without a terminal run unattended, and they say so before starting.

## When something goes wrong

| what you see | what it means | what to do |
|---|---|---|
| `Could not reach ...` | the API address or network failed | check the base URL, usually ending in `/v1` |
| `API key rejected` | the key is wrong or not allowed there | `ineed provider add <name>` with a new key |
| `this key is out of credit` | the provider quota is used up | top up, or switch provider with `ineed provider` |
| `this model does not exist at that provider` | the saved model is gone | `ineed provider` re-pulls the live list and picks a working one |
| `Out of steps` | the task needed more steps than the budget | say `continue`; raise the budget with `maxSteps` in the config or `INEED_MAX_STEPS=150` |
| `Stopped.` with a file list | you interrupted it | the files it already wrote are listed; re-run to continue |

## Point it at a local server

Any OpenAI-compatible server works, including one on your own machine:

```bash
ineed provider add local
# base URL: http://localhost:20128/v1   (or 11434 for Ollama, 1234 for LM Studio)
# model id: pick from the list, or type one
```

ineed tolerates servers that answer with a stream even when streaming was not
requested, or a JSON body with stream trailers attached.

## Settings

Everything lives in `~/.ineedcodes/config.json`. The guided menus (`/config`, `/status`,
`/provider`, `/model`) cover all of it; the table is for when you want to set something once.

| key | default | what it does |
|---|---|---|
| `provider` | `default` | which saved provider is active |
| `model` | from setup | model id sent to the provider |
| `maxSteps` | `100` | how many model rounds one task may take (5-200) |
| `tokenBudget` | `0` (off) | stop a task after this many tokens, so a runaway loop cannot spend your quota silently |
| `maxWorkers` | `4` | read-only sub-agents that may run at the same time (max 8) |
| `parallelReads` | `6` | read-only tool calls that may run at the same time (max 8) |
| `permEdit` | `ask` | `ask` before editing files, `allow` to stop asking |
| `permShell` | `ask` | `ask` before running commands, `allow` to stop asking |
| `permNet` | `allow` | `ask` before fetching web pages or using MCP tools |
| `humanize` | `true` | run the copy pass on written html/md/txt (adds a model call per file) |
| `memory` | `true` | remember durable facts between sessions |
| `mcp` | `true` | load configured MCP servers and their tools |
| `reasoning` | `low` | `high` thinks longer, costs more |
| `explain` | `normal` | `short`, `normal`, `deep` answer length |
| `mode` | `build` | `plan` is read-only |
| `models` | `{}` | per-role model ids for sub-agents, e.g. `{"research": "gpt-4o-mini"}` |
| `searchUrl` | none | search endpoint template with `{query}` for `web_search` |
| `tui` | auto | force the full-screen interface on or off |
| `theme` | `dark` | `light`, `mono`, `nord`, `dracula`, `synthwave` |

Environment variables win over the file: `INEED_BASE_URL`, `INEED_API_KEY`, `INEED_MODEL`,
`INEED_MAX_STEPS`, `INEED_TOKEN_BUDGET`. Useful for CI or a one-off run with no config at all.

## How it works

```
your words
    |
objective -> recall context -> pick tool -> real action -> observe result
    |                                                          |
    +------------- repeat until verified ----------------------+
    |
report with evidence
```

Not a chatbot that prints code. A loop that does the work, checks the results, and shows you the evidence.

### Tools

| tool | does |
|---|---|
| `list_files` | map the project |
| `read_file` | read code and configs |
| `search_text` | find anything, fast |
| `write_file` | create files |
| `edit_file` | targeted patch, not a rewrite |
| `delete_file` | remove a file |
| `todo` | visible checklist for multi-step work |
| `spawn_agent` | delegate to a focused sub-agent |
| `fetch_url` | read a web page or JSON API |
| `web_search` | search the web (bring your own provider) |
| `git_status` `git_diff` `git_log` `git_add` `git_commit` `git_restore` | git without the ceremony |
| `shell` | build, test, install, git, anything |

### Multi-agent

Big tasks get delegated. The lead agent spawns workers with a role that fits:

| role | can |
|---|---|
| `research` | read and report, nothing else, runs in parallel |
| `review` | inspect code, report findings, runs in parallel |
| `test` | run tests and commands, no source edits |
| `implement` | make the change, verify it |
| `debug` | find the root cause, fix it |

Workers report back with status, summary, evidence, files changed, and commands run. The lead reconciles everything and answers you.

### Skills

Portable `SKILL.md` folders teach ineed new behaviors. Drop one in `.ineedcodes/skills/` (this project), `~/.ineedcodes/skills/` (all projects), or use the built-in `humanizer`.

```
.ineedcodes/skills/my-skill/SKILL.md
---
name: my-skill
description: What it does, shown to the agent.
---
Instructions for the agent go here.
```

Project skills override global ones with the same name. List them with `/skills`.

### Project instructions

`AGENTS.md` or `.ineedcodes/instructions.md` in your repository loads automatically, every session.

### MCP (Model Context Protocol)

Connect any MCP server and its tools appear in the agent automatically. Create `~/.ineedcodes/mcp.json`:

```json
{
  "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }
}
```

Restart ineed, and every tool from that server is callable. Check what is loaded with `/mcp` inside a session.

### Safety

- Secrets (.env, ssh keys, pem files) never enter the model context.
- Destructive shell commands are refused.
- Everything is jailed to your working directory.
- Edits and shell commands ask for your approval first (`/perm auto` relaxes this).
- Plan mode lets you preview intent before any change.

## Works with any provider

OpenAI, iNeed API, OmniRoute, LM Studio, Ollama, vLLM, Groq, Together, OpenRouter, or anything that speaks the OpenAI format. You bring the key, ineed brings the agent.

## For beginners, by a beginner's journey

This project exists so anyone can start vibecoding: describe what you want, watch the agent work, learn from what it does. Free tutorials and AI resources live at [ineed.web.id](https://ineed.web.id), the product home is [ineed.codes](https://ineed.codes).

## Contributing

Issues and PRs are welcome at [github.com/salsabila2507/ineedcodes](https://github.com/salsabila2507/ineedcodes).

## License

[MIT](LICENSE) - 0xyas
