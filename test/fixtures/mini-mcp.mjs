// mini-mcp.mjs: a tiny MCP server for tests. Speaks newline-delimited JSON-RPC 2.0 over stdio.

import * as readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mini', version: '0.1.0' } }
    }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: [{ name: 'echo', description: 'Echo the message back', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] }
    }) + '\n');
  } else if (msg.method === 'tools/call') {
    const text = 'ECHO:' + String(msg.params?.arguments?.message ?? '');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } }) + '\n');
  }
});
