import { logger } from '../logger.js';
import type { ModelId } from './types.js';

/**
 * LLM sağlayıcı soyutlaması (FAZ A — BYOK temeli).
 *
 * Tek bir OpenAI-uyumlu istek katmanı ile şu sağlayıcılar desteklenir:
 *   - openrouter (varsayılan, geriye dönük uyumlu)
 *   - openai
 *   - gemini   (Google'ın OpenAI-uyumlu endpoint'i)
 *   - ollama   (lokal, ücretsiz, anahtar gerektirmez)
 *   - custom   (LM Studio / Groq / Together / vLLM — herhangi bir OpenAI-uyumlu URL)
 *
 * Seçim tamamen ortam değişkenleriyle yapılır; hiçbiri set değilse
 * mevcut davranış korunur (OpenRouter + OPENROUTER_API_KEY).
 *
 * Native Anthropic /v1/messages ve `claude` CLI (abonelik) → FAZ B.
 */

export type ProviderId = 'openrouter' | 'openai' | 'gemini' | 'ollama' | 'custom';

/** Somut model isimleri sağlayıcıya göre değişir → soyut kademe kullanıyoruz. */
type Tier = 'fast' | 'balanced' | 'smart';

const MODELID_TIER: Record<ModelId, Tier> = {
  haiku: 'fast',
  'gemini-flash': 'fast',
  deepseek: 'balanced',
  sonnet: 'balanced',
  opus: 'smart',
};

interface ProviderPreset {
  baseURL: string;
  /** Anahtarın okunacağı ortam değişkeni (ollama → null, anahtarsız). */
  keyEnv: string | null;
  models: Record<Tier, string>;
  /** Yaklaşık fiyat (USD / 1M token) — maliyet takibi için, best-effort. */
  pricing: Record<Tier, { input: number; output: number }>;
}

const PRESETS: Record<ProviderId, ProviderPreset> = {
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    models: {
      fast: 'anthropic/claude-haiku-4-5',
      balanced: 'anthropic/claude-sonnet-4-6',
      smart: 'anthropic/claude-opus-4-6',
    },
    pricing: {
      fast: { input: 0.8, output: 4 },
      balanced: { input: 3, output: 15 },
      smart: { input: 15, output: 75 },
    },
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    models: { fast: 'gpt-4o-mini', balanced: 'gpt-4o', smart: 'gpt-4o' },
    pricing: {
      fast: { input: 0.15, output: 0.6 },
      balanced: { input: 2.5, output: 10 },
      smart: { input: 2.5, output: 10 },
    },
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    models: { fast: 'gemini-2.5-flash', balanced: 'gemini-2.5-flash', smart: 'gemini-2.5-pro' },
    pricing: {
      fast: { input: 0.15, output: 0.6 },
      balanced: { input: 0.15, output: 0.6 },
      smart: { input: 1.25, output: 10 },
    },
  },
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    keyEnv: null,
    models: { fast: 'qwen2.5:7b', balanced: 'qwen2.5:7b', smart: 'qwen2.5:14b' },
    pricing: {
      fast: { input: 0, output: 0 },
      balanced: { input: 0, output: 0 },
      smart: { input: 0, output: 0 },
    },
  },
  custom: {
    baseURL: 'http://localhost:1234/v1', // LM Studio varsayılanı — LLM_BASE_URL ile ez
    keyEnv: 'LLM_API_KEY',
    models: { fast: 'local-model', balanced: 'local-model', smart: 'local-model' },
    pricing: {
      fast: { input: 0, output: 0 },
      balanced: { input: 0, output: 0 },
      smart: { input: 0, output: 0 },
    },
  },
};

export interface ResolvedProvider {
  id: ProviderId;
  baseURL: string;
  apiKey: string | null;
  /** ModelId → bu sağlayıcıdaki somut model ismi + fiyat. */
  resolve(model: ModelId): { modelName: string; pricing: { input: number; output: number } };
}

/**
 * Aktif sağlayıcıyı ortamdan çözer.
 *
 * Ortam değişkenleri:
 *   LLM_PROVIDER   — openrouter | openai | gemini | ollama | custom (varsayılan: openrouter)
 *   LLM_BASE_URL   — preset baseURL'i ez (custom endpoint / self-host proxy için)
 *   LLM_API_KEY    — genel anahtar ezmesi (preset keyEnv yerine)
 *   LLM_MODEL      — TÜM kademeleri tek somut modele sabitler (güç kullanıcı)
 */
export function resolveProvider(): ResolvedProvider {
  const id = (process.env.LLM_PROVIDER ?? 'openrouter').toLowerCase() as ProviderId;
  const preset = PRESETS[id];

  if (!preset) {
    throw new Error(
      `Bilinmeyen LLM_PROVIDER="${id}". Geçerli: ${Object.keys(PRESETS).join(', ')}`,
    );
  }

  const baseURL = (process.env.LLM_BASE_URL ?? preset.baseURL).replace(/\/+$/, '');

  // Anahtar önceliği: LLM_API_KEY (genel ezme) → preset.keyEnv → yok (ollama)
  const apiKey =
    process.env.LLM_API_KEY ??
    (preset.keyEnv ? process.env[preset.keyEnv] ?? null : null);

  // Ollama dışındaki tüm sağlayıcılar anahtar ister.
  if (id !== 'ollama' && !apiKey) {
    const hint = preset.keyEnv ? `${preset.keyEnv} veya LLM_API_KEY` : 'LLM_API_KEY';
    throw new Error(`LLM_PROVIDER="${id}" için API anahtarı gerekli — ${hint} set edilmeli.`);
  }

  const forcedModel = process.env.LLM_MODEL?.trim() || null;

  logger.debug({ provider: id, baseURL, forcedModel }, 'LLM provider resolved');

  return {
    id,
    baseURL,
    apiKey,
    resolve(model: ModelId) {
      const tier = MODELID_TIER[model] ?? 'balanced';
      return {
        modelName: forcedModel ?? preset.models[tier],
        pricing: preset.pricing[tier],
      };
    },
  };
}
