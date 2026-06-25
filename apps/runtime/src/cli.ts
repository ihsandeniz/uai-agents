import * as readline from 'node:readline';
import { ulid } from 'ulid';
import type { Task } from '@uai/shared';
import { CoreAgent } from './agents/core.js';
import { saveMemory, recallMemory } from './memory/service.js';
import { extractLearning } from './memory/learning.js';
import { getPendingApprovals, resolveApproval } from './approval/service.js';
import { startAwayMode, stopAwayMode, getAwayModeStatus, isAwayModeActive } from './away-mode.js';
import { db } from './db.js';
import { projects, tasks as tasksTable, learningLog } from '@uai/db/schema';
import { redis } from './redis.js';
import { logger } from './logger.js';
import { eq, desc } from 'drizzle-orm';

const core = new CoreAgent();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

function print(msg: string) {
  console.log(msg);
}

function printHeader() {
  print('');
  print('╔══════════════════════════════════════════╗');
  print('║     UAI Agents Team — Orchestrator CLI   ║');
  print('║     Core → Brain / Arch / ...            ║');
  print('╚══════════════════════════════════════════╝');
  print('');
  print('Komutlar:');
  print('  <görev>              — Core\'a görev ver (otomatik routing)');
  print('  /task <görev>        — Aynı şey, explicit');
  print('  /memory <sorgu>      — Memory\'de ara');
  print('  /save <içerik>       — Memory\'ye kaydet');
  print('  /agents              — Tüm ajanların durumu');
  print('  /history             — Son görevler');
  print('  /learnings           — Çıkarılan kurallar');
  print('  /approvals           — Bekleyen onaylar');
  print('  /approve <id>        — Onay ver');
  print('  /reject <id>         — Reddet');
  print('  /away <görev1; görev2> — Away Mode başlat');
  print('  /away-status         — Away Mode durumu');
  print('  /stop-away           — Away Mode durdur');
  print('  /help                — Bu menü');
  print('  /quit                — Çıkış');
  print('');
}

async function ensureDefaultProject(): Promise<string> {
  const projectId = 'default';
  const existing = await db.select().from(projects).where(eq(projects.id, projectId));
  if (existing.length === 0) {
    await db.insert(projects).values({
      id: projectId,
      name: 'UAI Default Project',
      goal: 'Multi-agent ile görev çözme',
      status: 'active',
    });
  }
  return projectId;
}

async function handleTask(input: string) {
  if (!input.trim()) {
    print('Kullanım: /task <görev açıklaması>');
    return;
  }

  const projectId = await ensureDefaultProject();
  const taskId = ulid();

  const task: Task = {
    id: taskId,
    projectId,
    goal: input,
    acceptanceCriteria: ['Görevi doğru ve eksiksiz tamamla', 'Açık ve anlaşılır yanıt ver'],
    assignedTo: 'core',
    status: 'in_progress',
    priority: 2,
    dependencies: [],
    createdAt: new Date(),
    startedAt: new Date(),
    refineCount: 0,
  };

  // Save task to DB
  await db.insert(tasksTable).values({
    id: task.id,
    projectId: task.projectId,
    goal: task.goal,
    acceptanceCriteria: task.acceptanceCriteria,
    assignedTo: task.assignedTo,
    status: task.status,
    priority: task.priority,
    dependencies: task.dependencies,
    refineCount: task.refineCount,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
  });

  print(`\n🎯 Core analiz ediyor... (task: ${taskId.slice(-6)})`);

  const result = await core.execute(task);

  // Update task in DB
  await db.update(tasksTable).set({
    status: 'done',
    completedAt: new Date(),
    result,
  }).where(eq(tasksTable.id, taskId));

  // Save to episodic memory
  await saveMemory({
    layer: 'episodic',
    content: `Görev: ${task.goal}\nSonuç: ${typeof result.output === 'string' ? result.output.slice(0, 1000) : JSON.stringify(result.output).slice(0, 1000)}`,
    agent: 'core',
    sourceTaskId: taskId,
    confidence: result.confidence,
    tags: ['task-result'],
  });

  // Extract learning (async, don't block CLI)
  extractLearning(task, result).catch((err) =>
    logger.warn({ err }, 'learning extraction background failed')
  );

  print(`\n📝 Sonuç (confidence: ${result.confidence.toFixed(2)}):`);
  print('─'.repeat(50));
  const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2);
  print(output);
  print('─'.repeat(50));
  print(`🧠 ${result.reasoning}`);
  print(`💰 Maliyet: $${result.costUsd.toFixed(6)} | 🔤 Token: ${result.tokensUsed}`);
}

async function handleMemorySearch(query: string) {
  if (!query.trim()) {
    print('Kullanım: /memory <arama sorgusu>');
    return;
  }

  const results = await recallMemory({ query, limit: 5 });

  if (results.length === 0) {
    print('Sonuç bulunamadı.');
    return;
  }

  print(`\n🧠 ${results.length} hafıza bulundu:\n`);
  for (const r of results) {
    print(`  [${r.layer}] (${r.metadata.agent}) confidence: ${r.metadata.confidence}`);
    print(`  ${r.content.slice(0, 200)}${r.content.length > 200 ? '...' : ''}`);
    print('');
  }
}

async function handleMemorySave(content: string) {
  if (!content.trim()) {
    print('Kullanım: /save <hafıza içeriği>');
    return;
  }

  const id = await saveMemory({
    layer: 'semantic',
    content,
    agent: 'core',
    confidence: 1.0,
    tags: ['manual'],
  });
  print(`✅ Hafıza kaydedildi: ${id.slice(-6)}`);
}

function handleAgents() {
  const statuses = core.getAgentStatuses();
  print('\n📊 Ajan Durumları:\n');
  for (const [name, info] of Object.entries(statuses)) {
    const icon = info.status === 'idle' ? '🟢' : info.status === 'working' ? '🔵' : info.status === 'error' ? '🔴' : '⚪';
    print(`  ${icon} ${name.padEnd(8)} ${info.status.padEnd(12)} $${info.cost.toFixed(6)}`);
  }
}

async function handleHistory() {
  const rows = await db
    .select()
    .from(tasksTable)
    .orderBy(desc(tasksTable.createdAt))
    .limit(10);

  if (rows.length === 0) {
    print('Henüz görev yok.');
    return;
  }

  print(`\n📋 Son görevler:\n`);
  for (const t of rows) {
    const status = t.status === 'done' ? '✅' : t.status === 'in_progress' ? '⏳' : '📌';
    const agent = t.assignedTo ? `[${t.assignedTo}]` : '';
    print(`  ${status} ${agent} ${t.goal?.slice(0, 60)}`);
  }
}

async function handleLearnings() {
  const rows = await db
    .select()
    .from(learningLog)
    .orderBy(desc(learningLog.createdAt))
    .limit(10);

  if (rows.length === 0) {
    print('Henüz öğrenme kaydı yok.');
    return;
  }

  print(`\n📚 Son öğrenmeler:\n`);
  for (const r of rows) {
    print(`  📌 Kural: ${r.ruleExtracted}`);
    if (r.whatWorked) print(`     ✅ İyi: ${r.whatWorked}`);
    if (r.whatDidnt) print(`     ❌ Kötü: ${r.whatDidnt}`);
    print('');
  }
}

async function handleApprovals() {
  const pending = await getPendingApprovals();

  if (pending.length === 0) {
    print('Bekleyen onay yok.');
    return;
  }

  print(`\n🔔 ${pending.length} bekleyen onay:\n`);
  for (const a of pending) {
    const color = a.actionClass === 'RED' ? '🔴' : '🟡';
    print(`  ${color} [${a.id.slice(-6)}] ${a.actionClass} — ${a.description}`);
    print(`     Öneren: ${a.proposedBy} | Görev: ${a.taskId.slice(-6)}`);
    print('');
  }
  print('Kullanım: /approve <id> veya /reject <id>');
}

async function handleApprove(idSuffix: string) {
  if (!idSuffix.trim()) {
    print('Kullanım: /approve <id-son-6-hane>');
    return;
  }
  const pending = await getPendingApprovals();
  const match = pending.find((a) => a.id.endsWith(idSuffix.trim()));
  if (!match) {
    print(`Onay bulunamadı: ${idSuffix}`);
    return;
  }
  await resolveApproval(match.id, true);
  print(`✅ Onaylandı: ${match.description}`);
}

async function handleReject(idSuffix: string) {
  if (!idSuffix.trim()) {
    print('Kullanım: /reject <id-son-6-hane>');
    return;
  }
  const pending = await getPendingApprovals();
  const match = pending.find((a) => a.id.endsWith(idSuffix.trim()));
  if (!match) {
    print(`Onay bulunamadı: ${idSuffix}`);
    return;
  }
  await resolveApproval(match.id, false);
  print(`❌ Reddedildi: ${match.description}`);
}

async function handleAway(input: string) {
  if (!input.trim()) {
    print('Kullanım: /away <görev1; görev2; görev3>');
    print('Görevleri ; ile ayırın.');
    return;
  }

  if (isAwayModeActive()) {
    print('⚠️  Away Mode zaten aktif. Durdurmak için /stop-away');
    return;
  }

  const goals = input.split(';').map((g) => g.trim()).filter(Boolean);
  if (goals.length === 0) {
    print('En az bir görev belirtin.');
    return;
  }

  print(`\n🚀 Away Mode başlatılıyor — ${goals.length} görev sırada...`);
  print('   Maliyet tavanı: $0.50/saat | Döngü algılama: aktif');
  print('   Durdurmak için: /stop-away\n');

  // Run in background so CLI stays responsive
  startAwayMode(goals).catch((err) =>
    print(`❌ Away Mode hata: ${err instanceof Error ? err.message : String(err)}`)
  );
}

function handleAwayStatus() {
  const status = getAwayModeStatus();
  if (!status.active) {
    print('Away Mode aktif değil.');
    return;
  }
  print('\n🌙 Away Mode Durumu:');
  print(`  ⏱️  Süre: ${status.elapsedMinutes}dk`);
  print(`  ✅ Tamamlanan: ${status.tasksCompleted} görev`);
  print(`  💰 Harcanan: $${status.totalCost?.toFixed(4)}`);
  print(`  📊 Tavan: $${status.costCeiling}/saat`);
}

async function handleStopAway() {
  if (!isAwayModeActive()) {
    print('Away Mode zaten aktif değil.');
    return;
  }
  await stopAwayMode();
  print('✅ Away Mode durduruldu.');
}

async function main() {
  // Connect Redis
  try {
    await redis.connect();
  } catch {
    logger.warn('Redis bağlantısı başarısız — devam ediliyor');
  }

  printHeader();

  while (true) {
    const input = await prompt('uai> ');
    const trimmed = input.trim();

    if (!trimmed) continue;

    try {
      if (trimmed === '/quit' || trimmed === '/exit') {
        print('👋 Görüşürüz!');
        break;
      } else if (trimmed === '/help') {
        printHeader();
      } else if (trimmed === '/agents') {
        handleAgents();
      } else if (trimmed === '/history') {
        await handleHistory();
      } else if (trimmed === '/learnings') {
        await handleLearnings();
      } else if (trimmed === '/approvals') {
        await handleApprovals();
      } else if (trimmed.startsWith('/approve')) {
        await handleApprove(trimmed.slice(8).trim());
      } else if (trimmed.startsWith('/reject')) {
        await handleReject(trimmed.slice(7).trim());
      } else if (trimmed.startsWith('/away-status')) {
        handleAwayStatus();
      } else if (trimmed.startsWith('/stop-away')) {
        await handleStopAway();
      } else if (trimmed.startsWith('/away')) {
        await handleAway(trimmed.slice(5).trim());
      } else if (trimmed.startsWith('/task')) {
        await handleTask(trimmed.slice(5).trim());
      } else if (trimmed.startsWith('/memory')) {
        await handleMemorySearch(trimmed.slice(7).trim());
      } else if (trimmed.startsWith('/save')) {
        await handleMemorySave(trimmed.slice(5).trim());
      } else if (trimmed.startsWith('/')) {
        print(`Bilinmeyen komut: ${trimmed.split(' ')[0]}. /help yazın.`);
      } else {
        // Default: treat as task — Core routes it
        await handleTask(trimmed);
      }
    } catch (err) {
      print(`❌ Hata: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  rl.close();
  redis.disconnect();
  process.exit(0);
}

main();
