/**
 * Minik yerel MCP sunucusu — Faz 1-2 canlı testi için stdio fixture.
 * Ağ gerektirmez; stdio üzerinden araçlar sunar: echo, add, pick, sumList, merge.
 * Kullanım (test scripti tarafından): tsx scripts/mcp-echo-server.ts
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

async function main() {
  const server = new McpServer({ name: 'echo-fixture', version: '0.1.0' });

  // scalar string
  server.registerTool(
    'echo',
    {
      description: 'Verilen metni aynen geri döndürür.',
      inputSchema: { text: z.string().describe('Yankılanacak metin') },
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  // scalar number (tip coercion testi)
  server.registerTool(
    'add',
    {
      description: 'İki sayıyı toplar.',
      inputSchema: { a: z.number().describe('Birinci sayı'), b: z.number().describe('İkinci sayı') },
    },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  );

  // enum (FAZ 2: izin listesi)
  server.registerTool(
    'pick',
    {
      description: 'Seçilen rengi döndürür.',
      inputSchema: { color: z.enum(['red', 'green', 'blue']).describe('Renk seçimi') },
    },
    async ({ color }) => ({ content: [{ type: 'text', text: `color=${color}` }] }),
  );

  // array (FAZ 2: JSON string arg → JSON.parse)
  server.registerTool(
    'sumList',
    {
      description: 'Sayı dizisinin toplamını döndürür.',
      inputSchema: { nums: z.array(z.number()).describe('Toplanacak sayılar') },
    },
    async ({ nums }) => ({ content: [{ type: 'text', text: String(nums.reduce((a, b) => a + b, 0)) }] }),
  );

  // object (FAZ 2: JSON string arg → JSON.parse)
  server.registerTool(
    'merge',
    {
      description: 'Nesnenin anahtarlarını sıralı döndürür.',
      inputSchema: { obj: z.record(z.string(), z.unknown()).describe('Anahtar-değer nesnesi') },
    },
    async ({ obj }) => ({ content: [{ type: 'text', text: Object.keys(obj).sort().join(',') }] }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
