import type { AgentName, Task, TaskResult } from '@uai/shared';
import { BaseAgent } from './base.js';
import { BrainAgent } from './brain.js';
import { ArchAgent } from './arch.js';
import { FrontAgent } from './front.js';
import { OpsAgent } from './ops.js';
import { QAAgent } from './qa.js';
import { logger } from '../logger.js';
import { send } from '../bus/index.js';
import { learning } from '../learning.js';

const CORE_SYSTEM = `Sen UAI sisteminin Core orkestratör ajanısın. Görevin:
- Gelen görevleri analiz edip doğru ajana yönlendirmek
- Karmaşık görevleri alt görevlere ayırmak ve paralel/bağımlı olarak yürütmek
- Sonuçları toplamak ve birleştirmek

Mevcut ajanlar:
- brain: Genel problem çözme, analiz, metin üretimi, kod yazma
- arch: Mimari kararlar, teknoloji seçimi, design pattern, code review
- front: Frontend/UI — React, Next.js, CSS, component, responsive, a11y
- ops: DevOps/Infra — Docker, CI/CD, deploy, monitoring, config, DB yönetimi

Görev yönlendirme kuralları:
- Mimari/tasarım sorusu → arch
- UI/frontend/component/CSS/responsive → front
- Docker/CI-CD/deploy/monitoring/infra → ops
- Diğer her şey → brain
- Karmaşık görevler → alt görevlere böl; bağımsız olanlar paralel çalışır, bağımlı olanlar sırayla

Alt görev bağımlılıkları (deps):
- deps: [] → bağımsız, hemen paralel çalışır
- deps: [1] → order=1 tamamlanınca çalışır, o çıktıyı context olarak alır
- Döngüsel bağımlılıktan kaçın (A→B→A gibi)`;

interface SubTask {
  goal: string;
  assignTo: AgentName;
  order: number;
  /** order values this subtask depends on — must complete first */
  deps: number[];
}

interface TaskAnalysis {
  complexity: 'simple' | 'medium' | 'complex';
  assignTo: AgentName;
  subtasks?: SubTask[];
  reasoning: string;
}

// Agent registry
const agents = new Map<AgentName, BaseAgent>();
const qaAgent = new QAAgent();

function getOrCreateAgent(name: AgentName): BaseAgent {
  let agent = agents.get(name);
  if (agent) return agent;

  switch (name) {
    case 'brain':
      agent = new BrainAgent();
      break;
    case 'arch':
      agent = new ArchAgent();
      break;
    case 'front':
      agent = new FrontAgent();
      break;
    case 'ops':
      agent = new OpsAgent();
      break;
    default:
      logger.warn({ agent: name }, 'unknown agent — falling back to brain');
      agent = new BrainAgent();
      break;
  }
  agents.set(name, agent);
  return agent;
}

export class CoreAgent extends BaseAgent {
  constructor() {
    super({
      name: 'core',
      model: 'haiku',  // Fast + cheap for routing decisions
      systemPrompt: CORE_SYSTEM,
      maxRetries: 1,
    });
  }

  /** Analyze and route the task */
  protected async think(task: Task): Promise<string> {
    logger.info({ task: task.id, goal: task.goal.slice(0, 80) }, 'core analyzing task');

    const prompt = `## Görev Analizi

**Görev:** ${task.goal}

Bu görevi analiz et ve yönlendir. JSON formatında yanıtla:
{
  "complexity": "simple|medium|complex",
  "assignTo": "brain|arch|front|ops",
  "subtasks": [
    {"goal": "alt görev açıklaması", "assignTo": "brain|arch|front|ops", "order": 1, "deps": []},
    {"goal": "önceki adıma bağımlı iş", "assignTo": "brain", "order": 2, "deps": [1]}
  ],
  "reasoning": "neden bu ajana/yapıya yönlendirdin"
}

Kurallar:
- simple/medium → tek ajan yeterli, subtasks boş bırak
- complex → alt görevlere böl (max 5)
- deps: [] → bağımsız, paralel çalışır; deps: [N] → N tamamlanınca çalışır
- Mimari/tasarım → arch | UI/frontend/CSS → front | Docker/CI-CD/infra → ops | Diğer → brain`;

    const result = await this.llm(prompt, { jsonMode: true, temperature: 0.2 });
    return result.text;
  }

  /** Execute by delegating to the right agent(s) */
  protected async act(task: Task, plan: string): Promise<TaskResult> {
    const analysis: TaskAnalysis = this.parseJson<TaskAnalysis>(plan) ?? {
      complexity: 'simple',
      assignTo: this.inferAgent(task.goal),
      reasoning: 'JSON parse failed — inferred from goal keywords',
    };

    // Learning override: if we have enough data, prefer learned routing
    const learnedAgent = learning.suggestAgent(task.goal);
    if (learnedAgent && learnedAgent !== analysis.assignTo) {
      logger.info({ original: analysis.assignTo, learned: learnedAgent, goal: task.goal.slice(0, 60) }, 'learning override');
      analysis.reasoning = `[Learning: ${analysis.assignTo}→${learnedAgent}] ${analysis.reasoning}`;
      analysis.assignTo = learnedAgent;
    }

    logger.info({
      task: task.id,
      complexity: analysis.complexity,
      assignTo: analysis.assignTo,
      subtaskCount: analysis.subtasks?.length ?? 0,
    }, 'core routing task');

    // Send routing notification
    await send('core', analysis.assignTo, 'task_assignment', {
      taskId: task.id,
      goal: task.goal,
      complexity: analysis.complexity,
    });

    // Simple/medium: single agent delegation
    if (analysis.complexity !== 'complex' || !analysis.subtasks?.length) {
      const agent = getOrCreateAgent(analysis.assignTo);
      const delegatedTask: Task = { ...task, assignedTo: analysis.assignTo };
      const result = await agent.execute(delegatedTask);

      await send(analysis.assignTo, 'core', 'task_result', {
        taskId: task.id,
        confidence: result.confidence,
      });

      return {
        ...result,
        reasoning: `[Core → ${analysis.assignTo}] ${analysis.reasoning}\n${result.reasoning}`,
      };
    }

    // Complex: DAG-aware parallel execution
    const orderedResults = await this.executeDAG(task, analysis.subtasks);

    // Collect in original order for output
    const allResults = [...orderedResults.values()].sort((a, b) => a.order - b.order);

    const mergedOutput = allResults
      .map((r) => `### Alt Görev ${r.order}\n${typeof r.result.output === 'string' ? r.result.output : JSON.stringify(r.result.output)}`)
      .join('\n\n');

    const avgConfidence = allResults.reduce((sum, r) => sum + r.result.confidence, 0) / allResults.length;
    const totalCost = allResults.reduce((sum, r) => sum + r.result.costUsd, 0);
    const totalTokens = allResults.reduce((sum, r) => sum + r.result.tokensUsed, 0);

    return {
      output: mergedOutput,
      artifactPaths: allResults.flatMap((r) => r.result.artifactPaths),
      confidence: avgConfidence,
      reasoning: `[Core DAG: ${allResults.length} subtasks] ${analysis.reasoning}`,
      tokensUsed: totalTokens,
      costUsd: totalCost + this.totalCost,
    };
  }

  /** QA review after task completion */
  protected override async reflect(task: Task, result: TaskResult): Promise<TaskResult> {
    // Run QA review
    const review = await qaAgent.review(task, result);

    logger.info({
      task: task.id,
      qaApproved: review.approved,
      qaScore: review.score,
      issues: review.issues.length,
    }, 'QA review complete');

    // Attach QA review to result
    const qaNote = review.approved
      ? `✅ QA onayladı (${review.score.toFixed(2)}): ${review.summary}`
      : `⚠️ QA sorun buldu (${review.score.toFixed(2)}): ${review.summary}\nSorunlar: ${review.issues.join(', ')}`;

    return {
      ...result,
      reasoning: `${result.reasoning}\n\n[QA] ${qaNote}`,
      confidence: review.approved ? Math.max(result.confidence, review.score) : (result.confidence + review.score) / 2,
    };
  }

  /**
   * Wave-based DAG executor.
   *
   * Each wave: find subtasks whose deps are all in `completed`, run them in
   * parallel with Promise.all, feed dep outputs as context, repeat.
   * Returns a Map<order, {order, result}>.
   */
  private async executeDAG(
    task: Task,
    subtasks: SubTask[],
  ): Promise<Map<number, { order: number; result: TaskResult }>> {
    const completed = new Set<number>();
    const resultMap = new Map<number, { order: number; result: TaskResult }>();

    // Normalise deps — treat missing as []
    const nodes = subtasks.map((s) => ({ ...s, deps: s.deps ?? [] }));

    let safetyLimit = subtasks.length + 1;

    while (resultMap.size < subtasks.length && safetyLimit-- > 0) {
      const wave = nodes.filter(
        (s) => !completed.has(s.order) && s.deps.every((d) => completed.has(d)),
      );

      if (wave.length === 0) {
        // Cycle or unresolvable deps — run remaining sequentially to avoid deadlock
        const remaining = nodes.filter((s) => !completed.has(s.order));
        logger.warn(
          { remaining: remaining.map((s) => s.order) },
          'DAG: unresolvable deps — falling back to sequential',
        );
        for (const sub of remaining) {
          const r = await this.runSubTask(task, sub, resultMap);
          resultMap.set(sub.order, { order: sub.order, result: r });
          completed.add(sub.order);
        }
        break;
      }

      logger.info(
        { wave: wave.map((s) => s.order), parallel: wave.length > 1 },
        'DAG wave starting',
      );

      const waveResults = await Promise.all(
        wave.map(async (sub) => {
          const result = await this.runSubTask(task, sub, resultMap);
          return { order: sub.order, result };
        }),
      );

      for (const entry of waveResults) {
        resultMap.set(entry.order, entry);
        completed.add(entry.order);
      }
    }

    return resultMap;
  }

  /** Execute a single subtask, injecting dep outputs as context if any */
  private async runSubTask(
    task: Task,
    sub: SubTask,
    resultMap: Map<number, { order: number; result: TaskResult }>,
  ): Promise<TaskResult> {
    const agent = getOrCreateAgent(sub.assignTo);

    // Build dep context string
    const depContext = (sub.deps ?? [])
      .map((d) => resultMap.get(d))
      .filter((e): e is { order: number; result: TaskResult } => !!e)
      .map((e) => {
        const out = typeof e.result.output === 'string'
          ? e.result.output.slice(0, 1500)
          : JSON.stringify(e.result.output).slice(0, 1500);
        return `### Adım ${e.order} Çıktısı\n${out}`;
      })
      .join('\n\n');

    const enrichedGoal = depContext
      ? `${sub.goal}\n\n## Önceki Adımların Çıktısı\n${depContext}`
      : sub.goal;

    const subTask: Task = {
      ...task,
      id: `${task.id}-sub-${sub.order}`,
      goal: enrichedGoal,
      assignedTo: sub.assignTo,
      parentId: task.id,
    };

    logger.info(
      { subtask: sub.order, agent: sub.assignTo, deps: sub.deps, goal: sub.goal.slice(0, 60) },
      'executing subtask',
    );

    return agent.execute(subTask);
  }

  /** Keyword-based agent inference as fallback */
  private inferAgent(goal: string): AgentName {
    const g = goal.toLowerCase();
    if (/\b(react|component|css|ui|frontend|responsive|tailwind|html|a11y|button|form|page|layout)\b/.test(g)) return 'front';
    if (/\b(docker|ci|cd|deploy|kubernetes|k8s|nginx|monitoring|infra|pipeline|helm)\b/.test(g)) return 'ops';
    if (/\b(mimari|architect|pattern|design.?pattern|microservice|monolith|trade.?off)\b/.test(g)) return 'arch';
    return 'brain';
  }

  /** Get status of all registered agents */
  getAgentStatuses(): Record<string, { status: string; cost: number }> {
    const statuses: Record<string, { status: string; cost: number }> = {
      core: { status: this.status, cost: this.totalCost },
    };
    for (const [name, agent] of agents) {
      statuses[name] = { status: agent.status, cost: agent.totalCost };
    }
    return statuses;
  }
}
