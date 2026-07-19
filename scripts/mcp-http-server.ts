/**
 * Minik yerel MCP sunucusu — Faz 2 HTTP (StreamableHTTP) transport testi için.
 * Bir HTTP portu dinler; tek araç sunar: ping (msg → "pong:msg").
 * Kullanım: MCP_HTTP_PORT=39917 tsx scripts/mcp-http-server.ts
 * stdout PROTOKOL için değil (ağ üzerinden) — loglar stderr'e gider.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

async function main() {
  const port = Number(process.env.MCP_HTTP_PORT) || 39917;

  const server = new McpServer({ name: 'http-fixture', version: '0.1.0' });
  server.registerTool(
    'ping',
    {
      description: 'Verilen mesajı pong olarak yankılar.',
      inputSchema: { msg: z.string().describe('Yankılanacak mesaj') },
    },
    async ({ msg }) => ({ content: [{ type: 'text', text: `pong:${msg}` }] }),
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    transport.handleRequest(req, res).catch((err) => {
      console.error('handleRequest error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  httpServer.listen(port, '127.0.0.1', () => {
    console.error(`http mcp fixture listening on 127.0.0.1:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
