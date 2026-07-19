/**
 * UAI'yi MCP SERVER olarak sunan entrypoint — FAZ 4.
 *
 * Taşıma:
 *   MCP_SERVE_TRANSPORT=stdio (varsayılan)  → stdio (yerel güven, ör. Claude Code config)
 *   MCP_SERVE_TRANSPORT=http                → HTTP (StreamableHTTP), X-Api-Key auth
 *
 * HTTP env:
 *   MCP_SERVE_PORT       (varsayılan 3100)
 *   MCP_SERVE_API_KEY    (yoksa UAI_API_KEY) — set ise X-Api-Key zorunlu
 *
 * Ortak env:
 *   MCP_SERVER_BASH_ALLOW=git status,ls,cat   → uai_run_bash allowlist önekleri
 *
 * Kullanım: MCP_SERVER_BASH_ALLOW="ls" tsx scripts/uai-mcp-server.ts
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createUaiMcpServer, bashAllowFromEnv } from '../apps/runtime/src/mcp/server.js';

async function main() {
  const server = createUaiMcpServer({ bashAllow: bashAllowFromEnv() });
  const transportKind = (process.env.MCP_SERVE_TRANSPORT ?? 'stdio').toLowerCase();

  if (transportKind === 'http') {
    const port = Number(process.env.MCP_SERVE_PORT) || 3100;
    const apiKey = process.env.MCP_SERVE_API_KEY ?? process.env.UAI_API_KEY;

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await server.connect(transport);

    const httpServer = http.createServer((req, res) => {
      // X-Api-Key auth — anahtar set ise zorunlu
      if (apiKey) {
        const provided = req.headers['x-api-key'];
        const key = Array.isArray(provided) ? provided[0] : provided;
        if (key !== apiKey) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'unauthorized — X-Api-Key gerekli' }));
          return;
        }
      }
      transport.handleRequest(req, res).catch((err) => {
        console.error('handleRequest error:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });

    httpServer.listen(port, '127.0.0.1', () => {
      console.error(`UAI MCP server (http) 127.0.0.1:${port} — auth: ${apiKey ? 'X-Api-Key' : 'yok'}`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('UAI MCP server (stdio) hazır');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
