/**
 * MCP FAZ 1-5 testi — config + köprü + canlı uçtan-uca (stdio + HTTP).
 * Kullanım: pnpm tsx scripts/test-mcp.ts
 *
 * 1) Offline: parseArgs (tırnak), resolveMcpConfig/Configs, köprü tip planı
 * 2) Canlı stdio: echo fixture → echo/add/pick/sumList/merge (enum+JSON args)
 * 3) Canlı HTTP: http fixture → StreamableHTTP transport → ping
 */
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { resolveMcpConfig, resolveMcpConfigs, parseArgs, mcpEnabledForAgent } from '../apps/runtime/src/mcp/config.js';
import { McpClient } from '../apps/runtime/src/mcp/client.js';
import { toToolDefinition, mcpToolName, registerMcpTools } from '../apps/runtime/src/mcp/bridge.js';
import { getMcpStats, resetMcpStats } from '../apps/runtime/src/mcp/observability.js';
import { isBashAllowed } from '../apps/runtime/src/mcp/server.js';
import { initMcp, shutdownMcp } from '../apps/runtime/src/mcp/index.js';
import { ALL_TOOLS, TOOL_MAP, getMcpTools } from '../apps/runtime/src/tools/registry.js';
import { BrainAgent } from '../apps/runtime/src/agents/brain.js';
import { OpsAgent } from '../apps/runtime/src/agents/ops.js';
import type { ToolDefinition } from '../apps/runtime/src/tools/types.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

/** Portun dinlemeye başlamasını bekle (TCP connect denemesiyle). */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} ${timeoutMs}ms içinde açılmadı`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clearMcpEnv(): void {
  for (const k of ['MCP_ENABLED', 'MCP_SERVER_COMMAND', 'MCP_SERVER_NAME', 'MCP_SERVER_ARGS', 'MCP_SERVERS', 'MCP_INIT_TIMEOUT_MS']) {
    delete process.env[k];
  }
}

async function main() {
  console.log('🧪 MCP FAZ 1-5 testi\n');

  // ── 1) Offline: config çözümleme ────────────────────────────────────────────
  console.log('[1] config çözümleme');
  clearMcpEnv();
  check('MCP kapalıyken null döner', resolveMcpConfig() === null);
  check('MCP kapalıyken configs boş', resolveMcpConfigs().length === 0);

  // parseArgs tırnak-duyarlı (FAZ 2)
  check('parseArgs tırnaklı arg', JSON.stringify(parseArgs('-y "@x/y z" a')) === '["-y","@x/y z","a"]', `→ ${JSON.stringify(parseArgs('-y "@x/y z" a'))}`);
  check('parseArgs boş → []', parseArgs('   ').length === 0);

  process.env.MCP_ENABLED = 'true';
  delete process.env.MCP_SERVER_COMMAND;
  let threw = false;
  try {
    resolveMcpConfig();
  } catch {
    threw = true;
  }
  check('komut yokken hata fırlatır', threw);

  process.env.MCP_SERVER_COMMAND = 'echo';
  process.env.MCP_SERVER_NAME = 'My Server!';
  process.env.MCP_SERVER_ARGS = 'a  b   c';
  const cfg = resolveMcpConfig();
  check('takma ad sanitize edildi', cfg?.name === 'my_server', `→ ${cfg?.name}`);
  check('argümanlar parçalandı', JSON.stringify(cfg?.args) === '["a","b","c"]', `→ ${JSON.stringify(cfg?.args)}`);
  check('legacy transport = stdio', cfg?.transport === 'stdio');

  // ── 1b) Çoklu sunucu (FAZ 2) ────────────────────────────────────────────────
  console.log('\n[1b] çoklu sunucu (MCP_SERVERS)');
  clearMcpEnv();
  process.env.MCP_SERVERS = JSON.stringify([
    { name: 'fs', transport: 'stdio', command: 'tsx', args: ['x.ts'] },
    { name: 'remote', transport: 'http', url: 'https://h.example/mcp', headers: { Authorization: 'Bearer t' } },
  ]);
  const multi = resolveMcpConfigs();
  check('iki sunucu çözüldü', multi.length === 2, `→ ${multi.length}`);
  check('http sunucu url + header', multi[1]?.transport === 'http' && multi[1]?.url === 'https://h.example/mcp' && multi[1]?.headers?.Authorization === 'Bearer t');

  clearMcpEnv();
  process.env.MCP_SERVERS = '{ not json ]';
  threw = false;
  try {
    resolveMcpConfigs();
  } catch {
    threw = true;
  }
  check('geçersiz MCP_SERVERS JSON → hata', threw);

  clearMcpEnv();
  process.env.MCP_SERVERS = JSON.stringify([{ name: 'bad', transport: 'http' }]);
  threw = false;
  try {
    resolveMcpConfigs();
  } catch {
    threw = true;
  }
  check('http url eksik → hata', threw);
  clearMcpEnv();

  // ── 2) Offline: köprü — tam JSON Schema (enum/array/object) ──────────────────
  console.log('\n[2] köprü (toToolDefinition — FAZ 2)');
  check('mcp öneki doğru', mcpToolName('srv', 'echo') === 'mcp__srv__echo');

  let capturedArgs: Record<string, unknown> | null = null;
  const fakeClient = {
    serverName: 'srv',
    async callTool(_name: string, args: Record<string, unknown>) {
      capturedArgs = args;
      return 'ok';
    },
  } as unknown as McpClient;

  const def = toToolDefinition(fakeClient, {
    name: 'compute',
    description: 'test',
    inputSchema: {
      type: 'object',
      properties: {
        s: { type: 'string', description: 'metin' },
        n: { type: 'integer', description: 'sayı' },
        b: { type: 'boolean', description: 'bayrak' },
        color: { type: 'string', enum: ['red', 'green'], description: 'renk' },
        nums: { type: 'array', description: 'sayılar' },
        obj: { type: 'object', description: 'nesne' },
      },
      required: ['s'],
    },
  });
  check('string arg → string', def.args.s?.type === 'string');
  check('integer arg → number', def.args.n?.type === 'number');
  check('boolean arg → boolean', def.args.b?.type === 'boolean');
  check('enum → string + izin listesi', def.args.color?.type === 'string' && def.args.color.description.includes('izin verilen'), `→ ${def.args.color?.description}`);
  check('array → string + JSON ipucu', def.args.nums?.type === 'string' && def.args.nums.description.includes('JSON dizisi'));
  check('object → string + JSON ipucu', def.args.obj?.type === 'string' && def.args.obj.description.includes('JSON nesnesi'));
  check('required doğru', def.args.s?.required === true && def.args.n?.required === false);

  const out = await def.execute({ s: 'hi', n: '42', b: 'true', color: 'red', nums: '[1,2,3]', obj: '{"k":1}' });
  check('execute yanıtı döner', out === 'ok');
  check('number coercion', capturedArgs?.n === 42, `→ ${capturedArgs?.n}`);
  check('boolean coercion', capturedArgs?.b === true);
  check('array JSON coercion', JSON.stringify(capturedArgs?.nums) === '[1,2,3]', `→ ${JSON.stringify(capturedArgs?.nums)}`);
  check('object JSON coercion', JSON.stringify(capturedArgs?.obj) === '{"k":1}', `→ ${JSON.stringify(capturedArgs?.obj)}`);
  check('string korunur', capturedArgs?.s === 'hi');

  // ── 3) Canlı stdio: echo fixture ────────────────────────────────────────────
  console.log('\n[3] canlı stdio — echo fixture');
  const stdioCfg = {
    name: 'echofix',
    transport: 'stdio' as const,
    command: 'tsx',
    args: ['scripts/mcp-echo-server.ts'],
    initTimeoutMs: 30_000,
  };
  const client = new McpClient(stdioCfg);
  await client.connect();
  check('fixture sunucuya bağlandı', client.isConnected);

  const tools = await client.listTools();
  check('5 araç listelendi', tools.length === 5, `→ ${tools.map((t) => t.name).join(',')}`);

  const map = new Map<string, ToolDefinition>();
  const all: ToolDefinition[] = [];
  await registerMcpTools(client, { all, map });

  const echoOut = await map.get('mcp__echofix__echo')!.execute({ text: 'merhaba MCP' });
  check('echo aracı çalıştı', echoOut === 'merhaba MCP', `→ "${echoOut}"`);

  const addOut = await map.get('mcp__echofix__add')!.execute({ a: '7', b: '5' });
  check('add (number coercion) çalıştı', addOut === '12', `→ "${addOut}"`);

  const pickOut = await map.get('mcp__echofix__pick')!.execute({ color: 'green' });
  check('pick (enum) çalıştı', pickOut === 'color=green', `→ "${pickOut}"`);

  const sumOut = await map.get('mcp__echofix__sumList')!.execute({ nums: '[10,20,30]' });
  check('sumList (array JSON) çalıştı', sumOut === '60', `→ "${sumOut}"`);

  const mergeOut = await map.get('mcp__echofix__merge')!.execute({ obj: '{"b":1,"a":2}' });
  check('merge (object JSON) çalıştı', mergeOut === 'a,b', `→ "${mergeOut}"`);

  await client.close();
  check('stdio istemci kapandı', !client.isConnected);

  // ── 4) Canlı HTTP: StreamableHTTP transport ─────────────────────────────────
  console.log('\n[4] canlı HTTP — StreamableHTTP transport');
  const port = 39917;
  let httpProc: ChildProcess | null = null;
  try {
    httpProc = spawn('tsx', ['scripts/mcp-http-server.ts'], {
      env: { ...process.env, MCP_HTTP_PORT: String(port) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForPort(port, 15_000);

    const httpClient = new McpClient({
      name: 'httpfix',
      transport: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      initTimeoutMs: 15_000,
    });
    await httpClient.connect();
    check('HTTP sunucuya bağlandı', httpClient.isConnected);

    const httpTools = await httpClient.listTools();
    check('HTTP araç listelendi (ping)', httpTools.some((t) => t.name === 'ping'), `→ ${httpTools.map((t) => t.name).join(',')}`);

    const pingOut = await httpClient.callTool('ping', { msg: 'faz2' });
    check('HTTP ping çalıştı', pingOut === 'pong:faz2', `→ "${pingOut}"`);

    await httpClient.close();
    check('HTTP istemci kapandı', !httpClient.isConnected);
  } finally {
    httpProc?.kill('SIGTERM');
  }

  // ── 5) Dayanıklılık: stdio alt-süreci öldür → otomatik reconnect ────────────
  console.log('\n[5] dayanıklılık — stdio reconnect');
  const rc = new McpClient(stdioCfg);
  await rc.connect();
  const pid1 = rc.pid;
  check('ilk stdio pid var', typeof pid1 === 'number', `→ ${pid1}`);
  process.kill(pid1!, 'SIGKILL');
  await delay(600); // sürecin ölmesini bekle
  const reOut = await rc.callTool('echo', { text: 'reconnected' });
  check('kopmadan sonra reconnect + çağrı', reOut === 'reconnected', `→ "${reOut}"`);
  const pid2 = rc.pid;
  check('yeni süreç farklı pid', typeof pid2 === 'number' && pid2 !== pid1, `→ ${pid1} → ${pid2}`);
  await rc.close();

  // ── 6) Ajan aboneliği + observability (FAZ 3) ───────────────────────────────
  console.log('\n[6] ajan aboneliği + observability');
  clearMcpEnv();
  // Araçları GERÇEK global kayıt defterine köprüle (ajanlar bunu okur)
  const gClient = new McpClient(stdioCfg);
  await gClient.connect();
  await registerMcpTools(gClient, { all: ALL_TOOLS, map: TOOL_MAP });
  check('global registry MCP araçları içeriyor', getMcpTools().length === 5, `→ ${getMcpTools().length}`);

  // mcpEnabledForAgent kapısı
  check('MCP_AGENTS boş → tüm ajanlar', mcpEnabledForAgent('brain') === true);
  process.env.MCP_AGENTS = 'ops';
  check('liste → yalnızca listelenen', mcpEnabledForAgent('brain') === false && mcpEnabledForAgent('ops') === true);
  process.env.MCP_AGENTS = 'none';
  check('none → hiçbiri', mcpEnabledForAgent('brain') === false);
  delete process.env.MCP_AGENTS;

  // Gerçek worker ctor'ları MCP araçlarına abone olur
  const brain = new BrainAgent();
  check('brain MCP aracına abone (varsayılan tümü)', brain.toolNames.includes('mcp__echofix__echo'), `→ ${brain.toolNames.join(',')}`);
  check('brain yerel araçlarını korudu', brain.toolNames.includes('readFile'));

  process.env.MCP_AGENTS = 'ops';
  const brain2 = new BrainAgent();
  const ops = new OpsAgent();
  check('gate: brain abone DEĞİL', !brain2.toolNames.includes('mcp__echofix__echo'));
  check('gate: ops abone', ops.toolNames.includes('mcp__echofix__echo'));
  delete process.env.MCP_AGENTS;

  // Observability — çağrı istatistikleri
  resetMcpStats();
  await TOOL_MAP.get('mcp__echofix__echo')!.execute({ text: 'gözlem' });
  await TOOL_MAP.get('mcp__echofix__add')!.execute({ a: '2', b: '3' });
  const stats = getMcpStats();
  check('stats toplam çağrı = 2', stats.totalCalls === 2, `→ ${stats.totalCalls}`);
  check('stats hata yok', stats.totalErrors === 0);
  check('stats araç bazında kayıt', stats.byTool['echofix__echo']?.calls === 1 && stats.byTool['echofix__add']?.calls === 1);

  await gClient.close();

  // ── 7) MCP SERVER — UAI'yi dışa sun (FAZ 4) ─────────────────────────────────
  console.log('\n[7] MCP SERVER — UAI dışa sunum');

  // isBashAllowed birim
  check('allowlist: boşsa RED', isBashAllowed('ls', []) === false);
  check('allowlist: tam eşleşme', isBashAllowed('ls', ['ls']) === true);
  check('allowlist: önek + boşluk', isBashAllowed('git status', ['git status']) === true && isBashAllowed('git push', ['git status']) === false);
  check('allowlist: kelime sınırı', isBashAllowed('lsof', ['ls']) === false);

  // 7a) Canlı stdio — UAI MCP server alt-süreci (McpClient kendi spawn'lar)
  const srvClient = new McpClient({
    name: 'uaisrv',
    transport: 'stdio',
    command: 'tsx',
    args: ['scripts/uai-mcp-server.ts'],
    // Açık env aktarımı (kör process.env aktarımı YOK) — allowlist'i böyle geçir
    env: { MCP_SERVER_BASH_ALLOW: 'echo' },
    initTimeoutMs: 30_000,
  });
  await srvClient.connect();
  check('UAI MCP server (stdio) bağlandı', srvClient.isConnected);

  const srvTools = await srvClient.listTools();
  const srvNames = srvTools.map((t) => t.name);
  check('server araçları sunuldu', ['uai_list_tools', 'uai_read_file', 'uai_search_web', 'uai_run_bash'].every((n) => srvNames.includes(n)), `→ ${srvNames.join(',')}`);
  check('writeFile dışa AÇILMADI', !srvNames.includes('uai_write_file'));

  const listOut = await srvClient.callTool('uai_list_tools', {});
  check('uai_list_tools yerel araçları döndürdü', listOut.includes('readFile') && listOut.includes('runBash'));

  const readOut = await srvClient.callTool('uai_read_file', { path: 'package.json' });
  check('uai_read_file package.json okudu', readOut.includes('"name": "uai"'), `→ ${readOut.slice(0, 40)}`);

  const bashOk = await srvClient.callTool('uai_run_bash', { command: 'echo merhaba' });
  check('uai_run_bash allowlist içi (echo)', bashOk.trim() === 'merhaba', `→ "${bashOk.trim()}"`);

  const bashBlocked = await srvClient.callTool('uai_run_bash', { command: 'ls /' });
  check('uai_run_bash allowlist dışı reddedildi', bashBlocked.includes("allowlist'te değil"), `→ ${bashBlocked.slice(0, 40)}`);

  await srvClient.close();

  // 7b) Canlı HTTP + X-Api-Key auth
  console.log('  — HTTP + X-Api-Key auth');
  const srvPort = 39918;
  const apiKey = 'gizli-anahtar-123';
  let httpSrvProc: ChildProcess | null = null;
  try {
    httpSrvProc = spawn('tsx', ['scripts/uai-mcp-server.ts'], {
      env: { ...process.env, MCP_SERVE_TRANSPORT: 'http', MCP_SERVE_PORT: String(srvPort), MCP_SERVE_API_KEY: apiKey },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForPort(srvPort, 15_000);

    // Doğru anahtarla → çalışır
    const authClient = new McpClient({
      name: 'uaihttp',
      transport: 'http',
      url: `http://127.0.0.1:${srvPort}/mcp`,
      headers: { 'X-Api-Key': apiKey },
      initTimeoutMs: 15_000,
    });
    await authClient.connect();
    check('HTTP doğru anahtarla bağlandı', authClient.isConnected);
    const httpList = await authClient.callTool('uai_list_tools', {});
    check('HTTP uai_list_tools çalıştı', httpList.includes('readFile'));
    await authClient.close();

    // Anahtarsız → 401, bağlanamaz
    const noAuthClient = new McpClient({
      name: 'noauth',
      transport: 'http',
      url: `http://127.0.0.1:${srvPort}/mcp`,
      initTimeoutMs: 8_000,
    });
    let authRejected = false;
    try {
      await noAuthClient.connect();
    } catch {
      authRejected = true;
    }
    await noAuthClient.close().catch(() => {});
    check('HTTP anahtarsız reddedildi (401)', authRejected);
  } finally {
    httpSrvProc?.kill('SIGTERM');
  }

  // ── 8) Entegrasyon: gerçek initMcp entrypoint (FAZ 5) ───────────────────────
  console.log('\n[8] entegrasyon — initMcp() uçtan uca');
  clearMcpEnv();
  // Gerçek başlatma yolu: MCP_SERVERS env → initMcp → global registry → ajan görür
  process.env.MCP_SERVERS = JSON.stringify([
    { name: 'e2e', transport: 'stdio', command: 'tsx', args: ['scripts/mcp-echo-server.ts'] },
  ]);
  await initMcp();
  check('initMcp global registry\'e köprüledi', getMcpTools().some((t) => t.name === 'mcp__e2e__echo'));
  const brainE2e = new BrainAgent();
  check('worker initMcp sonrası e2e aracına abone', brainE2e.toolNames.includes('mcp__e2e__echo'));
  const e2eOut = await TOOL_MAP.get('mcp__e2e__echo')!.execute({ text: 'entegrasyon' });
  check('e2e araç canlı çalıştı', e2eOut === 'entegrasyon', `→ "${e2eOut}"`);
  await shutdownMcp();
  check('shutdownMcp temiz kapandı', true);
  clearMcpEnv();

  // ── Özet ────────────────────────────────────────────────────────────────────
  console.log(`\n📊 ${passed} geçti, ${failed} kaldı`);
  if (failed > 0) process.exit(1);
  console.log('✅ MCP FAZ 1-5 testi başarılı!');
}

main().catch((err) => {
  console.error('❌ MCP testi başarısız:', err);
  process.exit(1);
});
