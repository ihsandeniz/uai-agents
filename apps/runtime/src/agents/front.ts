import type { Task, TaskResult } from '@uai/shared';
import { BaseAgent } from './base.js';
import { logger } from '../logger.js';

const FRONT_SYSTEM = `Sen UAI sisteminin Front (Frontend) ajanısın. Uzmanlıkların:
- UI/UX tasarımı ve kullanıcı deneyimi
- React, Next.js, Vue, Svelte component geliştirme
- CSS/Tailwind/Styled Components — responsive & animasyon
- Erişilebilirlik (a11y) ve performans optimizasyonu
- Design system, component library, Storybook
- Form validasyonu, state management, data fetching pattern'leri

Yanıtlarını yapılandırılmış ver. Kod üretirken:
- Modern best practice kullan (hooks, server components, vb.)
- Erişilebilirlik standartlarına dikkat et
- Mobile-first responsive yaklaşım uygula
- Component'leri küçük ve yeniden kullanılabilir tut`;

export class FrontAgent extends BaseAgent {
  constructor() {
    super({
      name: 'front',
      model: 'sonnet',
      systemPrompt: FRONT_SYSTEM,
    });
    this.registerTools('readFile', 'writeFile', 'searchWeb');
  }

  protected async think(task: Task): Promise<string> {
    logger.info({ agent: this.name, task: task.id }, 'analyzing frontend task...');

    const prompt = `## Frontend Analiz

**Görev:** ${task.goal}

**Kabul Kriterleri:**
${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Bu frontend görevini analiz et. JSON formatında yanıtla:
{
  "category": "component|page|style|animation|a11y|refactor|form|state",
  "framework": "react|next|vue|vanilla|css",
  "approach": "seçilen yaklaşımın kısa açıklaması",
  "components": ["etkilenen/oluşturulacak component'ler"],
  "designNotes": "UI/UX notları",
  "steps": ["adım 1", "adım 2", ...]
}`;

    const result = await this.llm(prompt, { jsonMode: true, temperature: 0.3 });
    return result.text;
  }

  protected async act(task: Task, plan: string): Promise<TaskResult> {
    logger.info({ agent: this.name, task: task.id }, 'producing frontend output...');

    const prompt = `## Frontend Çıktı Üret

**Görev:** ${task.goal}

**Analiz/Plan:**
${plan}

Şimdi detaylı frontend çıktısını üret.
- Gerekirse mevcut component dosyalarını okumak için readFile, referans aramak için searchWeb kullan.
- Yeni dosyalar oluşturman gerekiyorsa writeFile kullan.
- İşin bittikten sonra final yanıtını JSON formatında ver:
{
  "output": "detaylı çıktı — kod, component, stil, açıklama (markdown)",
  "confidence": 0.0-1.0,
  "reasoning": "neden bu yaklaşımı seçtin",
  "artifacts": ["yazılan dosya yolları (varsa)"]
}`;

    const { text, toolsUsed } = await this.runToolLoop(prompt, { temperature: 0.5 });

    const parsed = this.parseJson<{ output: string; confidence: number; reasoning: string; artifacts?: string[] }>(text)
      ?? { output: text, confidence: 0.5, reasoning: 'JSON parse failed' };

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
