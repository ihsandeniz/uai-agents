import { logger } from '../logger.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export type ModelId = 'sonnet' | 'haiku' | 'opus' | 'gemini-flash' | 'deepseek';

const MODEL_MAP: Record<ModelId, string> = {
  sonnet: 'anthropic/claude-sonnet-4-6',
  haiku: 'anthropic/claude-haiku-4-5',
  opus: 'anthropic/claude-opus-4-6',
  'gemini-flash': 'google/gemini-2.5-flash-preview',
  deepseek: 'deepseek/deepseek-chat-v3',
};

// OpenRouter pricing (approx, per million tokens)
const PRICING: Record<ModelId, { input: number; output: number }> = {
  sonnet: { input: 3, output: 15 },
  haiku: { input: 0.8, output: 4 },
  opus: { input: 15, output: 75 },
  'gemini-flash': { input: 0.15, output: 0.6 },
  deepseek: { input: 0.27, output: 1.1 },
};

export interface CompletionOptions {
  model?: ModelId;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionResult {
  text: string;
  tokensUsed: { input: number; output: number };
  costUsd: number;
  model: string;
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  return key;
}

export async function complete(opts: CompletionOptions): Promise<CompletionResult> {
  const model = opts.model ?? 'sonnet';
  const modelId = MODEL_MAP[model];

  logger.debug({ model, promptLength: opts.prompt.length }, 'LLM call start');

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: opts.prompt });

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.7,
  };

  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
      'HTTP-Referer': 'https://uai.local',
      'X-Title': 'UAI Agents Team',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
    model: string;
  };

  const text = data.choices[0]?.message?.content ?? '';

  const tokensUsed = {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
  };

  const pricing = PRICING[model];
  const costUsd =
    (tokensUsed.input * pricing.input + tokensUsed.output * pricing.output) / 1_000_000;

  logger.info(
    { model: data.model, tokensIn: tokensUsed.input, tokensOut: tokensUsed.output, costUsd: costUsd.toFixed(6) },
    'LLM call complete'
  );

  return { text, tokensUsed, costUsd, model: data.model ?? modelId };
}

/** Multi-turn chat completion — pass full message history */
export async function chat(
  messages: ChatMessage[],
  opts?: { model?: ModelId; maxTokens?: number; temperature?: number },
): Promise<CompletionResult> {
  const model = opts?.model ?? 'sonnet';
  const modelId = MODEL_MAP[model];

  logger.debug({ model, turns: messages.length }, 'LLM chat start');

  const body = {
    model: modelId,
    messages,
    max_tokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature ?? 0.5,
  };

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
      'HTTP-Referer': 'https://uai.local',
      'X-Title': 'UAI Agents Team',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${err}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
    model: string;
  };

  const text = data.choices[0]?.message?.content ?? '';
  const tokensUsed = {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
  };
  const pricing = PRICING[model];
  const costUsd = (tokensUsed.input * pricing.input + tokensUsed.output * pricing.output) / 1_000_000;

  logger.info(
    { model: data.model, tokensIn: tokensUsed.input, tokensOut: tokensUsed.output, costUsd: costUsd.toFixed(6) },
    'LLM chat complete',
  );

  return { text, tokensUsed, costUsd, model: data.model ?? modelId };
}

export async function embed(text: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    logger.debug('OPENAI_API_KEY not set — skipping embedding, using keyword search');
    return [];
  }

  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'embed() API error — falling back to keyword search');
      return [];
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? [];
  } catch (err) {
    logger.warn({ err }, 'embed() failed — falling back to keyword search');
    return [];
  }
}
