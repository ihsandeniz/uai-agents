import { logger } from '../logger.js';
import { resolveProvider, resolveEmbedProvider } from './config.js';
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

/**
 * Semantik hafıza embedding'i — BYOK katmanı üzerinden (bkz. resolveEmbedProvider).
 *
 * Boş dizi dönmek "embedding yok, anahtar kelime aramasına düş" demektir. Bu
 * fallback bilinçlidir; **sessiz** olması değildi — 2026-08-11 doc-sync'te kapalı
 * olduğu hiçbir yerde görünmediği için ollama kurulumlarında semantik hafıza
 * aylarca ölü kaldı. Artık kapalıysa açılışta WARN basılır (logEmbedStatus) ve
 * ilk çağrıda bir kez daha gerekçesiyle uyarılır.
 */
let embedDisabledWarned = false;

export async function embed(text: string): Promise<number[]> {
  const resolution = resolveEmbedProvider();

  if (!resolution.enabled) {
    if (!embedDisabledWarned) {
      embedDisabledWarned = true;
      logger.warn(
        { code: resolution.reason.code },
        `embed() devre dışı — ${resolution.reason.message}`,
      );
    }
    return [];
  }

  const { baseURL, apiKey, model, dimensions } = resolution.provider;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseURL}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: text }),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status, baseURL, model },
        'embed() API error — falling back to keyword search',
      );
      return [];
    }

    const data = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    const vector = data.data?.[0]?.embedding ?? [];

    // Sağlayıcı beyan edilenden farklı boyut dönerse DB INSERT'i patlar → burada kes.
    if (vector.length > 0 && vector.length !== dimensions) {
      logger.error(
        { expected: dimensions, got: vector.length, model, baseURL },
        'embed() boyut uyuşmazlığı — vektör atıldı, anahtar kelime aramasına düşülüyor',
      );
      return [];
    }

    return vector;
  } catch (err) {
    logger.warn({ err, baseURL, model }, 'embed() failed — falling back to keyword search');
    return [];
  }
}
