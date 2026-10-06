#!/usr/bin/env node
// Prints the tool definitions as an MCP client receives them (all, or the ones named), to see what the tool list costs.
//   node bench/tokens/dump-tools.ts [name …]
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isolatedEnv, ROOT } from '../../test/lib/helpers.ts';

const { env } = isolatedEnv({ vars: { VR_REMOTE: '0' } });
const client = new Client({ name: 'dump-tools', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin/vr-mcp')], env: env as Record<string, string>, stderr: 'ignore' }),
);
const { tools } = await client.listTools();
const names = process.argv.slice(2);
for (const t of tools) if (!names.length || names.includes(t.name)) console.log(`${JSON.stringify(t)}\n`);
await client.close();
