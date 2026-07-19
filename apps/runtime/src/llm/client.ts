import { logger } from '../logger.js';
import { resolveProvider } from './config.js';
import type {
  ChatMessage,
  CompletionOptions,
  CompletionResult,
  ModelId,
} from './types.js';

// Tipleri geriye dönük uyumluluk için yeniden ihraç et (eski import yolları çalışsın).
export type { ChatMessage, CompletionOptions, CompletionResult, ModelId } from './types.js';

/**
 * OpenAI-uyumlu /chat/completions çağrısı — aktif sağlayıcıya göre
 * baseURL/apiKey/model çözülür. OpenRouter, OpenAI, Gemini (openai-compat),
 * Ollama ve herhangi bir OpenAI-uyumlu endpoint bu tek yol üzerinden çalışır.
 */
async function openaiCompatChat(
  messages: Array<{ role: string; content: string }>,
  opts: { model: ModelId; maxTokens: number; temperature: number; jsonMode?: boolean },
): Promise<CompletionResult> {
  const provider = resolveProvider();
  const { modelName, pricing } = provider.resolve(opts.model);

  const body: Record<string, unknown> = {
    model: modelName,
    messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  // OpenRouter'a özgü (opsiyonel) atıf başlıkları — diğerleri yok sayar.
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://uai.local';
    headers['X-Title'] = 'UAI Agents Team';
  }

  const response = await fetch(`${provider.baseURL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error (${provider.id}) ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
    model?: string;
  };

  const text = data.choices[0]?.message?.content ?? '';
  const tokensUsed = {
    input: data.usage?.prompt_tokens ?? 0,
    output: data.usage?.completion_tokens ?? 0,
  };
  const costUsd =
    (tokensUsed.input * pricing.input + tokensUsed.output * pricing.output) / 1_000_000;

  logger.info(
    {
      provider: provider.id,
      model: data.model ?? modelName,
      tokensIn: tokensUsed.input,
      tokensOut: tokensUsed.output,
      costUsd: costUsd.toFixed(6),
    },
    'LLM call complete',
  );

  return { text, tokensUsed, costUsd, model: data.model ?? modelName };
}

export async function complete(opts: CompletionOptions): Promise<CompletionResult> {
  const model = opts.model ?? 'sonnet';
  logger.debug({ model, promptLength: opts.prompt.length }, 'LLM call start');

  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) {
    messages.push({ role: 'system', content: opts.system });
  }
  messages.push({ role: 'user', content: opts.prompt });

  return openaiCompatChat(messages, {
    model,
    maxTokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.7,
    jsonMode: opts.jsonMode,
  });
}

/** Multi-turn chat completion — pass full message history */
export async function chat(
  messages: ChatMessage[],
  opts?: { model?: ModelId; maxTokens?: number; temperature?: number },
): Promise<CompletionResult> {
  const model = opts?.model ?? 'sonnet';
  logger.debug({ model, turns: messages.length }, 'LLM chat start');

  return openaiCompatChat(messages, {
    model,
    maxTokens: opts?.maxTokens ?? 4096,
    temperature: opts?.temperature ?? 0.5,
  });
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

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? [];
  } catch (err) {
    logger.warn({ err }, 'embed() failed — falling back to keyword search');
    return [];
  }
}
