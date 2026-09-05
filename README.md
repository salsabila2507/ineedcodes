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
| `/plan` | read-only mode, the agent suggests but changes nothing |
| `/build` | default mode, the agent makes real changes |
| `/reason` | toggle reasoning effort low/high |
| `/perm` | permission modes: `/perm auto`, `/perm safe` |
| `/memory` | durable memory status, `/memory on\|off` |
| `/mcp` | list MCP servers and their tools |
| `/setup` | redo provider setup |
| `/config` | show provider config, API key hidden |
| `/clear` | forget the current conversation |
| `/exit` | quit |

Shortcuts are optional. Normal language always works.

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
