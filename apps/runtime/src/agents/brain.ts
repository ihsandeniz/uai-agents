import type { Task, TaskResult } from '@uai/shared';
import { BaseAgent } from './base.js';
import { logger } from '../logger.js';

const BRAIN_SYSTEM = `Sen UAI sisteminin Brain ajanısın. Görevin:
- Kullanıcı taleplerini analiz etmek
- Adım adım plan oluşturmak
- Planı uygulamak ve sonuç üretmek
- Çıktının kalitesini self-review ile değerlendirmek

Yanıtlarını yapılandırılmış ver. Türkçe veya İngilizce — kullanıcının diline uy.
Confidence 0-1 arası: 0.8+ = eminim, 0.5-0.8 = makul, <0.5 = emin değilim.`;

export class BrainAgent extends BaseAgent {
  constructor() {
    super({
      name: 'brain',
      model: 'sonnet',
      systemPrompt: BRAIN_SYSTEM,
    });
    // Brain can read files, search the web, and run safe shell commands
    this.registerTools('readFile', 'writeFile', 'searchWeb', 'runBash');
  }

  protected async think(task: Task): Promise<string> {
    logger.info({ agent: this.name, task: task.id }, 'thinking...');

    const prompt = `## Görev Analizi

**Hedef:** ${task.goal}

**Kabul Kriterleri:**
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Lütfen bu görevi adım adım nasıl çözeceğini planla. JSON formatında yanıtla:
{
  "analysis": "görevin kısa analizi",
  "steps": ["adım 1", "adım 2", ...],
  "estimatedComplexity": "low|medium|high",
  "risks": ["olası risk 1", ...]
}`;

    const result = await this.llm(prompt, { jsonMode: true, temperature: 0.3 });
    return result.text;
  }

  protected async act(task: Task, plan: string): Promise<TaskResult> {
    logger.info({ agent: this.name, task: task.id }, 'executing plan...');

    const prompt = `## Plan Uygulama

**Hedef:** ${task.goal}

**Plan:**
${plan}

Şimdi bu planı uygula ve sonucu üret.
- Gerekirse readFile, writeFile, searchWeb veya runBash araçlarını kullan.
- Araç kullanımın bittikten sonra (veya araç gerekmiyorsa) final yanıtını JSON formatında ver:
{
  "output": "görevin çıktısı (detaylı)",
  "confidence": 0.0-1.0,
  "reasoning": "neden bu sonuca ulaştın"
}`;

    const { text, toolsUsed } = await this.runToolLoop(prompt, { temperature: 0.5 });

    const parsed = this.parseJson<{ output: string; confidence: number; reasoning: string }>(text)
      ?? { output: text, confidence: 0.5, reasoning: 'JSON parse failed — raw output used' };

    const toolNote = toolsUsed.length > 0
      ? ` [tools: ${toolsUsed.map((t) => t.name).join(', ')}]`
      : '';

    return {
      output: parsed.output,
      artifactPaths: [],
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      reasoning: parsed.reasoning + toolNote,
      tokensUsed: this.totalTokens.input + this.totalTokens.output,
      costUsd: this.totalCost,
    };
  }

  protected override async reflect(task: Task, result: TaskResult): Promise<TaskResult> {
    if (result.confidence >= 0.7) return result;

    logger.info({ agent: this.name, confidence: result.confidence }, 'self-review — confidence low');

    const prompt = `## Self-Review

**Görev:** ${task.goal}
**Üretilen Çıktı:** ${typeof result.output === 'string' ? result.output : JSON.stringify(result.output)}
**Kabul Kriterleri:**
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Bu çıktı kabul kriterlerini karşılıyor mu? İyileştirme gerekiyorsa yeni versiyon üret. JSON:
{
  "meetsRequirements": true/false,
  "improvedOutput": "iyileştirilmiş çıktı (gerekiyorsa)",
  "confidence": 0.0-1.0,
  "reasoning": "değerlendirme"
}`;

    const review = await this.llm(prompt, { jsonMode: true, temperature: 0.3 });

    const parsed2 = this.parseJson<{ meetsRequirements: boolean; improvedOutput?: string; confidence: number; reasoning: string }>(review.text);
    if (parsed2) {
      if (parsed2.improvedOutput && !parsed2.meetsRequirements) {
        return {
          ...result,
          output: parsed2.improvedOutput,
          confidence: parsed2.confidence,
          reasoning: `Revised: ${parsed2.reasoning}`,
          tokensUsed: this.totalTokens.input + this.totalTokens.output,
          costUsd: this.totalCost,
        };
      }
      return { ...result, confidence: parsed2.confidence };
    }
    return result;
  }
}
