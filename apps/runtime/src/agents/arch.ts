import type { Task, TaskResult } from '@uai/shared';
import { BaseAgent } from './base.js';
import { logger } from '../logger.js';

const ARCH_SYSTEM = `Sen UAI sisteminin Arch (Mimari) ajanısın. Uzmanlıkların:
- Yazılım mimarisi ve tasarım pattern'leri
- Teknoloji seçimi ve trade-off analizi
- Kod yapısı, dosya organizasyonu
- Code review ve refactoring önerileri
- Performans ve ölçeklenebilirlik analizi

Yanıtlarını yapılandırılmış ve detaylı ver.
Mimari kararlarda her zaman trade-off'ları belirt.
Pragmatik ol — overengineering'den kaçın.`;

export class ArchAgent extends BaseAgent {
  constructor() {
    super({
      name: 'arch',
      model: 'sonnet',
      systemPrompt: ARCH_SYSTEM,
    });
    this.registerTools('readFile', 'searchWeb');
  }

  protected async think(task: Task): Promise<string> {
    logger.info({ agent: this.name, task: task.id }, 'analyzing architecture...');

    const prompt = `## Mimari Analiz

**Görev:** ${task.goal}

**Kabul Kriterleri:**
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Bu görevi mimari perspektiften analiz et. JSON formatında yanıtla:
{
  "category": "design-pattern|tech-choice|code-review|architecture|refactoring",
  "approach": "seçilen yaklaşımın kısa açıklaması",
  "tradeoffs": [{"option": "seçenek", "pros": ["artı"], "cons": ["eksi"]}],
  "recommendation": "önerilen yaklaşım",
  "steps": ["adım 1", "adım 2", ...]
}`;

    const result = await this.llm(prompt, { jsonMode: true, temperature: 0.3 });
    return result.text;
  }

  protected async act(task: Task, plan: string): Promise<TaskResult> {
    logger.info({ agent: this.name, task: task.id }, 'producing architecture output...');

    const prompt = `## Mimari Çıktı Üret

**Görev:** ${task.goal}

**Analiz/Plan:**
${plan}

Şimdi detaylı mimari çıktıyı üret.
- Gerekirse mevcut kodu okumak için readFile, referans aramak için searchWeb kullan.
- İşin bittikten sonra final yanıtını JSON formatında ver:
{
  "output": "detaylı mimari çıktı/öneri/review (markdown formatında)",
  "confidence": 0.0-1.0,
  "reasoning": "neden bu yaklaşımı seçtin",
  "artifacts": ["üretilen dosya/diyagram listesi (varsa)"]
}`;

    const { text, toolsUsed } = await this.runToolLoop(prompt, { temperature: 0.4 });

    const parsed = this.parseJson<{ output: string; confidence: number; reasoning: string; artifacts?: string[] }>(text)
      ?? { output: text, confidence: 0.6, reasoning: 'JSON parse failed' };

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
