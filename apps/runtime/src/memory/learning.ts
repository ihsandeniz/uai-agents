import { db } from '../db.js';
import { learningLog } from '@uai/db/schema';
import { saveMemory } from './service.js';
import { complete } from '../llm/client.js';
import { logger } from '../logger.js';
import { ulid } from 'ulid';
import type { Task, TaskResult, AgentName } from '@uai/shared';

export interface LearningEntry {
  taskId: string;
  whatWorked: string;
  whatDidnt: string;
  ruleExtracted: string;
}

/** Extract learning from a completed task */
export async function extractLearning(task: Task, result: TaskResult): Promise<LearningEntry | null> {
  // Only learn from tasks with enough signal
  if (!task.assignedTo) return null;

  const prompt = `## Öğrenme Çıkarımı

**Görev:** ${task.goal}
**Ajan:** ${task.assignedTo}
**Confidence:** ${result.confidence}
**Sonuç:** ${typeof result.output === 'string' ? result.output.slice(0, 500) : JSON.stringify(result.output).slice(0, 500)}
**Reasoning:** ${result.reasoning}

Bu görevden ne öğrenebiliriz? JSON formatında yanıtla:
{
  "whatWorked": "neyin iyi gittiği (kısa)",
  "whatDidnt": "neyin kötü gittiği veya iyileştirilebileceği (kısa, yoksa boş string)",
  "ruleExtracted": "gelecek görevler için çıkarılan kural (tek cümle, somut ve uygulanabilir)"
}

Eğer görevden anlamlı bir öğrenme çıkaramıyorsan (çok basit/rutin):
{
  "whatWorked": "",
  "whatDidnt": "",
  "ruleExtracted": ""
}`;

  try {
    const llmResult = await complete({
      model: 'haiku',  // Cheap for meta-analysis
      prompt,
      system: 'Sen bir öğrenme çıkarım sistemisin. Kısa ve somut yanıtlar ver.',
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 300,
    });

    const parsed = JSON.parse(llmResult.text) as LearningEntry;

    // Skip empty learnings
    if (!parsed.ruleExtracted) return null;

    // Save to learning_log table
    await db.insert(learningLog).values({
      id: ulid(),
      taskId: task.id,
      whatWorked: parsed.whatWorked,
      whatDidnt: parsed.whatDidnt,
      ruleExtracted: parsed.ruleExtracted,
      createdAt: new Date(),
    });

    // Save rule as procedural memory
    const memoryId = await saveMemory({
      layer: 'procedural',
      content: `KURAL: ${parsed.ruleExtracted}\nKaynak görev: ${task.goal}\nAjan: ${task.assignedTo}`,
      agent: task.assignedTo as AgentName,
      sourceTaskId: task.id,
      confidence: result.confidence,
      tags: ['rule', 'auto-extracted'],
    });

    // Update learning log with memory reference
    // (leaving appliedToMemoryId for now — could update later)

    logger.info({ taskId: task.id, rule: parsed.ruleExtracted.slice(0, 60) }, 'learning extracted');
    return { ...parsed, taskId: task.id };
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'learning extraction failed — skipping');
    return null;
  }
}
