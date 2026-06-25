import type { Task, TaskResult } from '@uai/shared';
import { BaseAgent } from './base.js';
import { logger } from '../logger.js';

const OPS_SYSTEM = `Sen UAI sisteminin Ops (DevOps/Infrastructure) ajanısın. Uzmanlıkların:
- Docker, Docker Compose, Kubernetes konfigürasyonu
- CI/CD pipeline tasarımı (GitHub Actions, GitLab CI)
- Deploy stratejileri (blue-green, canary, rolling)
- Monitoring, logging, alerting yapılandırması
- Nginx, Caddy, reverse proxy konfigürasyonu
- Environment yönetimi, secret management
- Performans tuning, caching stratejileri
- Veritabanı yönetimi, migration, backup

Yanıtlarını yapılandırılmış ver. Konfigürasyon üretirken:
- Production-ready ve güvenli ol
- Her zaman rollback planı belirt
- Secret'ları hardcode etme, env variable kullan
- Health check ve graceful shutdown ekle`;

export class OpsAgent extends BaseAgent {
  constructor() {
    super({
      name: 'ops',
      model: 'sonnet',
      systemPrompt: OPS_SYSTEM,
    });
    // Ops can read/write files and run shell commands (primary use-case for infra work)
    this.registerTools('readFile', 'writeFile', 'runBash', 'searchWeb');
  }

  protected async think(task: Task): Promise<string> {
    logger.info({ agent: this.name, task: task.id }, 'analyzing ops task...');

    const prompt = `## DevOps/Infra Analiz

**Görev:** ${task.goal}

**Kabul Kriterleri:**
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Bu infrastructure/devops görevini analiz et. JSON formatında yanıtla:
{
  "category": "docker|ci-cd|deploy|monitoring|config|database|security|networking",
  "environment": "dev|staging|production|all",
  "approach": "seçilen yaklaşımın kısa açıklaması",
  "risks": ["olası risk ve mitigation"],
  "rollbackPlan": "geri alma planı",
  "steps": ["adım 1", "adım 2", ...]
}`;

    const result = await this.llm(prompt, { jsonMode: true, temperature: 0.2 });
    return result.text;
  }

  protected async act(task: Task, plan: string): Promise<TaskResult> {
    logger.info({ agent: this.name, task: task.id }, 'producing ops output...');

    const prompt = `## DevOps/Infra Çıktı Üret

**Görev:** ${task.goal}

**Analiz/Plan:**
${plan}

Şimdi detaylı infrastructure çıktısını üret.
- Gerekirse mevcut dosyaları okumak için readFile, komut çalıştırmak için runBash kullan.
- Konfigürasyon/script dosyaları yazman gerekiyorsa writeFile kullan.
- İşin bittikten sonra final yanıtını JSON formatında ver:
{
  "output": "detaylı çıktı — config, script, Dockerfile, pipeline yaml, açıklama (markdown)",
  "confidence": 0.0-1.0,
  "reasoning": "neden bu yaklaşımı seçtin",
  "artifacts": ["yazılan dosya yolları (varsa)"]
}`;

    const { text, toolsUsed } = await this.runToolLoop(prompt, { temperature: 0.3 });

    let parsed: { output: string; confidence: number; reasoning: string; artifacts?: string[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = this.parseJson<typeof parsed>(text)
        ?? { output: text, confidence: 0.5, reasoning: 'JSON parse failed' };
    }

    const toolNote = toolsUsed.length > 0
      ? ` [tools: ${toolsUsed.map((t) => t.name).join(', ')}]`
      : '';

    return {
      output: parsed.output,
      artifactPaths: parsed.artifacts ?? [],
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reasoning: parsed.reasoning + toolNote,
      tokensUsed: this.totalTokens.input + this.totalTokens.output,
      costUsd: this.totalCost,
    };
  }
}
