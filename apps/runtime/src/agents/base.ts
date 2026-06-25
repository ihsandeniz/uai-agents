import type { AgentName, AgentStatus, Task, TaskResult } from '@uai/shared';
import { complete, chat, type ChatMessage, type ModelId, type CompletionResult } from '../llm/client.js';
import { recallMemory } from '../memory/service.js';
import { publishEvent } from '../events.js';
import { logger } from '../logger.js';
import { ulid } from 'ulid';
import { type ToolDefinition, type ToolCall, type ToolResult } from '../tools/types.js';
import { TOOL_MAP, buildToolSchema } from '../tools/registry.js';

export interface AgentConfig {
  name: AgentName;
  model: ModelId;
  systemPrompt: string;
  maxRetries?: number;
  /** Max cost per task in USD (default: 0.50) */
  maxCostPerTask?: number;
}

export abstract class BaseAgent {
  readonly name: AgentName;
  protected model: ModelId;
  protected systemPrompt: string;
  protected maxRetries: number;
  protected maxCostPerTask: number;
  private _status: AgentStatus = 'idle';
  private _totalCost = 0;
  private _taskCost = 0;
  private _totalTokens = { input: 0, output: 0 };
  protected _memoryContext = '';
  /** Subset of tools this agent can use (empty = no tool-use) */
  protected _tools: ToolDefinition[] = [];

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
    this.maxRetries = config.maxRetries ?? 2;
    this.maxCostPerTask = config.maxCostPerTask ?? 0.50;
  }

  get status(): AgentStatus { return this._status; }
  get totalCost(): number { return this._totalCost; }
  get totalTokens() { return { ...this._totalTokens }; }

  protected setStatus(s: AgentStatus) {
    this._status = s;
    logger.debug({ agent: this.name, status: s }, 'agent status change');
    publishEvent({ type: 'agent_status', data: { agent: this.name, status: s, cost: this._totalCost } }).catch(() => {});
  }

  /** Core think→act→reflect loop with retry */
  async execute(task: Task): Promise<TaskResult> {
    let lastError: unknown;

    this._taskCost = 0;

    // Load relevant memories before first attempt
    this._memoryContext = await this._fetchMemoryContext(task.goal);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      this.setStatus('thinking');

      try {
        if (attempt > 0) {
          logger.info({ agent: this.name, task: task.id, attempt }, 'retrying task');
          await this.delay(1000 * attempt); // exponential-ish backoff
        }

        // 1. Think — analyze the task
        const plan = await this.think(task);

        // 2. Act — do the work
        this.setStatus('working');
        const result = await this.act(task, plan);

        // 3. Reflect — self-review
        const reviewed = await this.reflect(task, result);

        this.setStatus('idle');
        return reviewed;
      } catch (err) {
        lastError = err;
        const isRetryable = this.isRetryableError(err);
        logger.warn({ agent: this.name, task: task.id, attempt, retryable: isRetryable, err }, 'agent execution error');

        if (!isRetryable || attempt >= this.maxRetries) break;
      }
    }

    this.setStatus('error');
    logger.error({ agent: this.name, task: task.id, err: lastError }, 'agent execution failed after retries');
    return {
      output: `Error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      artifactPaths: [],
      confidence: 0,
      reasoning: `Execution failed after ${this.maxRetries + 1} attempts`,
      tokensUsed: this._totalTokens.input + this._totalTokens.output,
      costUsd: this._totalCost,
    };
  }

  /** Analyze task and produce a plan */
  protected abstract think(task: Task): Promise<string>;

  /** Execute the plan and produce a result */
  protected abstract act(task: Task, plan: string): Promise<TaskResult>;

  /** Self-review the result, optionally retry */
  protected async reflect(task: Task, result: TaskResult): Promise<TaskResult> {
    // Default: accept if confidence >= 0.6, otherwise retry once
    if (result.confidence >= 0.6) return result;

    logger.info({ agent: this.name, confidence: result.confidence }, 'low confidence — retrying');
    this.setStatus('thinking');
    const plan = await this.think(task);
    this.setStatus('working');
    return this.act(task, plan);
  }

  /** Call LLM and track costs */
  protected async llm(prompt: string, opts?: { maxTokens?: number; temperature?: number; jsonMode?: boolean }): Promise<CompletionResult> {
    if (this._taskCost >= this.maxCostPerTask) {
      throw new Error(`Cost ceiling reached ($${this._taskCost.toFixed(4)} >= $${this.maxCostPerTask})`);
    }

    const effectiveSystem = this._memoryContext
      ? `${this.systemPrompt}\n\n## Relevant Memory Context\n${this._memoryContext}`
      : this.systemPrompt;

    const result = await complete({
      model: this.model,
      system: effectiveSystem,
      prompt,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
      jsonMode: opts?.jsonMode,
    });

    this._totalCost += result.costUsd;
    this._taskCost += result.costUsd;
    this._totalTokens.input += result.tokensUsed.input;
    this._totalTokens.output += result.tokensUsed.output;

    return result;
  }

  /** Check if error is retryable (network/rate-limit, not logic errors) */
  private isRetryableError(err: unknown): boolean {
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      return msg.includes('rate') || msg.includes('timeout') || msg.includes('429')
        || msg.includes('502') || msg.includes('503') || msg.includes('network')
        || msg.includes('econnrefused') || msg.includes('fetch failed');
    }
    return false;
  }

  /** Simple delay helper */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Register tools this agent may call. Call in subclass constructor.
   * Pass tool names — they are looked up from the global TOOL_MAP.
   */
  protected registerTools(...names: string[]): void {
    for (const name of names) {
      const tool = TOOL_MAP.get(name);
      if (tool) this._tools.push(tool);
      else logger.warn({ agent: this.name, tool: name }, 'registerTools: unknown tool');
    }
  }

  /**
   * Tool-use agentic loop.
   *
   * Sends `userPrompt` with tool schema in system context. Parses `<tool_call>` XML
   * blocks from the LLM response, executes each tool, feeds results back, and loops
   * until the LLM produces a response with no tool calls or maxIterations is reached.
   *
   * Returns the final text response (no tool calls remaining).
   */
  protected async runToolLoop(
    userPrompt: string,
    opts?: { maxIterations?: number; temperature?: number; maxTokens?: number },
  ): Promise<{ text: string; toolsUsed: ToolResult[] }> {
    const maxIterations = opts?.maxIterations ?? 6;
    const allToolResults: ToolResult[] = [];

    const effectiveSystem = this._buildSystemWithTools();

    const messages: ChatMessage[] = [
      { role: 'system', content: effectiveSystem },
      { role: 'user', content: userPrompt },
    ];

    for (let iter = 0; iter < maxIterations; iter++) {
      if (this._taskCost >= this.maxCostPerTask) {
        throw new Error(`Cost ceiling reached ($${this._taskCost.toFixed(4)})`);
      }

      const result = await chat(messages, {
        model: this.model,
        maxTokens: opts?.maxTokens ?? 4096,
        temperature: opts?.temperature ?? 0.5,
      });

      this._totalCost += result.costUsd;
      this._taskCost += result.costUsd;
      this._totalTokens.input += result.tokensUsed.input;
      this._totalTokens.output += result.tokensUsed.output;

      const toolCalls = this._parseToolCalls(result.text);

      if (toolCalls.length === 0) {
        // No more tool calls — final answer
        return { text: result.text, toolsUsed: allToolResults };
      }

      // Append assistant message with tool calls
      messages.push({ role: 'assistant', content: result.text });

      // Execute each tool call and collect results
      const resultLines: string[] = [];
      for (const call of toolCalls) {
        const toolResult = await this._executeTool(call);
        allToolResults.push(toolResult);
        resultLines.push(
          `<tool_result name="${toolResult.name}">\n${toolResult.error ? `ERROR: ${toolResult.error}` : toolResult.output}\n</tool_result>`,
        );
        logger.debug(
          { agent: this.name, tool: call.name, hasError: !!toolResult.error },
          'tool executed',
        );
      }

      // Feed results back as user message
      messages.push({ role: 'user', content: resultLines.join('\n\n') });
    }

    // Exhausted iterations — return last assistant content or a note
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    return {
      text: lastAssistant?.content ?? '(tool loop exhausted max iterations)',
      toolsUsed: allToolResults,
    };
  }

  /** Build system prompt with tool schema injected */
  private _buildSystemWithTools(): string {
    const base = this._memoryContext
      ? `${this.systemPrompt}\n\n## Relevant Memory Context\n${this._memoryContext}`
      : this.systemPrompt;

    if (this._tools.length === 0) return base;

    const schema = buildToolSchema(this._tools);
    return `${base}

## Available Tools

You may call tools by including one or more \`<tool_call>\` blocks in your response.
Format:

\`\`\`
<tool_call>
{"name": "toolName", "args": {"argName": "value"}}
</tool_call>
\`\`\`

After a tool call the system will reply with <tool_result> blocks containing the output.
Call as many tools as needed across multiple turns before giving your final answer.
When you have enough information, respond WITHOUT any <tool_call> blocks.

${schema}`;
  }

  /** Parse all <tool_call> JSON blocks from LLM text */
  private _parseToolCalls(text: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(m[1]) as { name: string; args?: Record<string, string> };
        if (parsed.name) calls.push({ name: parsed.name, args: parsed.args ?? {} });
      } catch {
        logger.warn({ agent: this.name, raw: m[1].slice(0, 200) }, 'failed to parse tool_call JSON');
      }
    }
    return calls;
  }

  /** Execute a single tool call safely */
  private async _executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = this._tools.find((t) => t.name === call.name) ?? TOOL_MAP.get(call.name);
    if (!tool) {
      return { name: call.name, args: call.args, output: '', error: `Unknown tool: ${call.name}` };
    }
    try {
      const output = await tool.execute(call.args);
      return { name: call.name, args: call.args, output };
    } catch (err) {
      return {
        name: call.name,
        args: call.args,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Fetch relevant memories and format as context string */
  private async _fetchMemoryContext(goal: string): Promise<string> {
    try {
      const memories = await recallMemory({ query: goal, agent: this.name, limit: 5 });
      if (memories.length === 0) return '';
      return memories.map((m) => `- [${m.layer}] ${m.content}`).join('\n');
    } catch {
      return '';
    }
  }

  /** Parse JSON from LLM response, handling code fences and extra text */
  protected parseJson<T>(raw: string): T | null {
    try { return JSON.parse(raw); } catch {}
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) { try { return JSON.parse(fenceMatch[1].trim()); } catch {} }
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
    return null;
  }

  /** Generate a unique ID */
  protected id(): string {
    return ulid();
  }
}
