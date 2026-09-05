// mcp.js: minimal MCP client. Connects MCP servers over stdio using JSON-RPC 2.0,
// lists their tools, and lets the agent call them like native tools.
// Servers are configured in ~/.ineedcodes/mcp.json: { "name": { "command": "...", "args": ["..."] } }

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const MCP_CONFIG_FILE = process.env.INEED_MCP_CONFIG
  || path.join(os.homedir(), '.ineedcodes', 'mcp.json');

let nextId = 1;

class McpServer {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.child = null;
    this.buffer = '';
    this.pending = new Map(); // id -> resolve
    this.tools = [];
    this.dead = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        child = spawn(this.spec.command, this.spec.args ?? [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, NO_COLOR: '1' }
        });
      } catch (err) {
        this.dead = true;
        return reject(new Error(`cannot start MCP server ${this.name}: ${err.message}`));
      }
      this.child = child;
      child.stdout.on('data', chunk => {
        this.buffer += chunk.toString();
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id && this.pending.has(msg.id)) {
            const r = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            r(msg);
          }
        }
      });
      child.stderr.on('data', () => {}); // servers log freely; never leaks into the model
      child.on('error', err => {
        this.dead = true;
        if (!settled) { settled = true; reject(new Error(`MCP server ${this.name}: ${err.message}`)); }
      });
      child.on('close', code => {
        this.dead = true;
        for (const r of this.pending.values()) r({ error: { message: `MCP server ${this.name} exited (code ${code})` } });
        this.pending.clear();
      });
      const fail = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(`MCP server ${this.name} did not answer initialize (10s)`)); }
      }, 10_000);
      this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ineed', version: '1.1.0' }
      }).then(init => {
        if (init.error) throw new Error(init.error.message ?? 'initialize failed');
        this.notify('notifications/initialized', {});
        clearTimeout(fail);
        settled = true;
        resolve(this);
      }).catch(err => {
        clearTimeout(fail);
        settled = true;
        this.kill();
        reject(err);
      });
    });
  }

  request(method, params) {
    if (this.dead) return Promise.resolve({ error: { message: `MCP server ${this.name} is not running` } });
    const id = nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `MCP server ${this.name} timed out on ${method}` } });
      }, 60_000);
      this.pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ error: { message: `MCP write failed: ${err.message}` } });
      }
    });
  }

  notify(method, params) {
    try { this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch {}
  }

  async listTools() {
    const res = await this.request('tools/list', {});
    if (res.error) return [];
    this.tools = (res.result?.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} }
    }));
    return this.tools;
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args ?? {} });
    if (res.error) return { output: `Error: MCP ${this.name}/${name}: ${res.error.message}` };
    const parts = res.result?.content ?? [];
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    return { output: (res.result?.isError ? 'Error: ' : '') + (text || '(empty result)') };
  }

  kill() {
    this.dead = true;
    try { this.child?.kill('SIGKILL'); } catch {}
  }
}

export class McpManager {
  constructor() {
    this.servers = new Map();
  }

  async loadFromConfig() {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf8')); } catch { return []; }
    const errors = [];
    for (const [name, spec] of Object.entries(cfg)) {
      if (!spec?.command) { errors.push(`mcp: ${name} has no command`); continue; }
      if (this.servers.has(name)) continue;
      try {
        const server = new McpServer(name, spec);
        await server.start();
        this.servers.set(name, server);
      } catch (err) {
        errors.push(err.message);
      }
    }
    return errors;
  }

  // native-style tool descriptors, namespaced mcp_<server>_<tool>
  async allTools() {
    const out = [];
    for (const [serverName, server] of this.servers) {
      for (const t of await server.listTools()) {
        out.push({
          name: `mcp_${serverName}_${t.name}`.slice(0, 64).replace(/[^a-zA-Z0-9_]/g, '_'),
          description: `[MCP ${serverName}] ${t.description}`.trim(),
          parameters: jsonSchemaToParameters(t.inputSchema),
          mcp: { server: serverName, tool: t.name },
          allowedInPlan: false
        });
      }
    }
    return out;
  }

  hasTools() {
    for (const s of this.servers.values()) if (!s.dead && s.tools.length) return true;
    return this.servers.size > 0;
  }

  async call(serverName, toolName, args) {
    const server = this.servers.get(serverName);
    if (!server) return { output: `Error: unknown MCP server ${serverName}` };
    if (server.dead) return { output: `Error: MCP server ${serverName} is not running` };
    return server.callTool(toolName, args);
  }

  killAll() {
    for (const s of this.servers.values()) s.kill();
    this.servers.clear();
  }
}

function jsonSchemaToParameters(schema) {
  // OpenAI function parameters are JSON Schema; pass through with light sanitation
  const s = schema && typeof schema === 'object' ? schema : { type: 'object' };
  if (s.type !== 'object') return { type: 'object', properties: {} };
  return { type: 'object', properties: s.properties ?? {}, required: s.required ?? [] };
}

export function mcpConfigured() {
  try { return Object.keys(JSON.parse(fs.readFileSync(MCP_CONFIG_FILE, 'utf8'))).length > 0; } catch { return false; }
}
