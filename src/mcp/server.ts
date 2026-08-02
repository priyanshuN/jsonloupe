// jsonloupe as an MCP server: the third host for the same engine (the browser
// is the host for eyes, `npx jsonloupe` the host for offline, this one for
// agents). It speaks JSON-RPC over stdio and makes no network calls of any
// kind — it reads only the files a client hands it by path.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DocPool } from './pool';
import { threadDocHost } from './thread-host';
import { TOOLS, ToolRouter } from './tools';

const VERSION = '1.1.0';

const INSTRUCTIONS = `jsonloupe holds large or lossless JSON documents outside your context and answers
questions about them. Load a document once with load_doc, then work from its
docId: get_schema to learn the shape, run_query to count/filter/group,
sample to read real values, diff_docs to compare two loads, export_csv to write
a table to disk. Every response is capped, so refine queries rather than asking
for everything. Numbers keep their exact digits — an int64 id read here is the
id, not a float that looks like one.`;

export async function main(): Promise<void> {
  const pool = new DocPool(() => threadDocHost());
  const router = new ToolRouter(pool);

  const server = new Server(
    { name: 'jsonloupe', version: VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { text, isError } = await router.call(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    );
    return { content: [{ type: 'text' as const, text }], isError };
  });

  const shutdown = (): void => {
    void pool.closeAll().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
}
