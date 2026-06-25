import type { Task, TaskResult } from '@uai/shared';
import { BaseAgent } from './base.js';
import { logger } from '../logger.js';

const QA_SYSTEM = `Sen UAI sisteminin QA (Kalite Kontrol) ajanısın. Görevin:
- Task sonuçlarını kabul kriterlerine karşı doğrulamak
- Hata, eksiklik, tutarsızlık bulmak
- İyileştirme önerileri sunmak
- Sonucun yayınlanabilir kalitede olup olmadığına karar vermek

Eleştirel ama yapıcı ol. Her zaman somut örneklerle açıkla.
Score 0-1: 0.8+ = yayınlanabilir, 0.5-0.8 = iyileştirme gerekli, <0.5 = reddet.`;

export interface QAReview {
  approved: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  summary: string;
}

export class QAAgent extends BaseAgent {
  constructor() {
    super({
      name: 'qa',
      model: 'haiku',  // Fast + cheap for review
      systemPrompt: QA_SYSTEM,
    });
  }

  /** Review a task result against acceptance criteria */
  async review(task: Task, result: TaskResult): Promise<QAReview> {
    logger.info({ agent: this.name, task: task.id }, 'reviewing task result');

    const prompt = `## QA Review

**Görev:** ${task.goal}

**Kabul Kriterleri:**
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

**Üretilen Sonuç:**
${typeof result.output === 'string' ? result.output.slice(0, 2000) : JSON.stringify(result.output).slice(0, 2000)}

**Agent Confidence:** ${result.confidence}
**Reasoning:** ${result.reasoning}

Bu sonucu değerlendir. JSON formatında yanıtla:
{
  "approved": true/false,
  "score": 0.0-1.0,
  "issues": ["bulunan sorun 1", "sorun 2"],
  "suggestions": ["iyileştirme önerisi 1", "öneri 2"],
  "summary": "tek cümle değerlendirme"
}`;

    const llmResult = await this.llm(prompt, { jsonMode: true, temperature: 0.2, maxTokens: 500 });

    const parsed = this.parseJson<QAReview>(llmResult.text);
    if (parsed) {
      logger.info({
        task: task.id,
        approved: parsed.approved,
        score: parsed.score,
        issueCount: parsed.issues?.length ?? 0,
      }, 'QA review complete');
      return {
        approved: parsed.approved ?? result.confidence >= 0.7,
        score: parsed.score ?? result.confidence,
        issues: parsed.issues ?? [],
        suggestions: parsed.suggestions ?? [],
        summary: parsed.summary ?? 'QA review',
      };
    }
    return {
      approved: result.confidence >= 0.7,
      score: result.confidence,
      issues: ['QA review parse failed'],
      suggestions: [],
      summary: 'Otomatik değerlendirme — parse hatası',
    };
  }

  // BaseAgent abstract methods — QA primarily uses review(), not execute()
  protected async think(task: Task): Promise<string> {
    return JSON.stringify({ action: 'review', taskId: task.id });
  }

  protected async act(task: Task, _plan: string): Promise<TaskResult> {
    return {
      output: 'QA agent — use review() method directly',
      artifactPaths: [],
      confidence: 1,
      reasoning: 'QA acts through review, not direct execution',
      tokensUsed: 0,
      costUsd: 0,
    };
  }
}
