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
  /**
   * Sağlayıcının OpenAI-uyumlu /embeddings desteği.
   * `null` = sağlayıcı embedding sunmuyor (ör. OpenRouter) → embed katmanı başka
   * bir kaynağa düşmek zorunda. Bkz. resolveEmbedProvider().
   */
  embed: { model: string; dimensions: number } | null;
}

/**
 * `memory.embedding` kolonu `vector(1536)` olarak sabit (db/schema.ts:45).
 * Farklı boyutlu bir embedding modeli seçilirse INSERT anında patlar; bu yüzden
 * uyuşmazlık **çağrı anında değil, çözümleme anında** yakalanır ve embed kapatılır.
 */
export const EMBED_COLUMN_DIMENSIONS = 1536;

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
    // OpenRouter /embeddings sunmaz (2026-08 itibarıyla) → embed başka kaynaktan gelir.
    embed: null,
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
    embed: { model: 'text-embedding-3-small', dimensions: 1536 },
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
    // 768 boyut — vector(1536) kolonuyla uyuşmaz; resolveEmbedProvider bunu yakalar.
    embed: { model: 'text-embedding-004', dimensions: 768 },
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
    // 768 boyut — vector(1536) kolonuyla uyuşmaz; resolveEmbedProvider bunu yakalar.
    embed: { model: 'nomic-embed-text', dimensions: 768 },
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
    // Bilinmiyor — EMBED_MODEL + EMBED_DIMENSIONS ile açıkça verilmeli.
    embed: null,
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

// ---------------------------------------------------------------------------
// Embedding sağlayıcısı (semantik hafıza)
// ---------------------------------------------------------------------------

export interface ResolvedEmbedProvider {
  baseURL: string;
  apiKey: string | null;
  model: string;
  dimensions: number;
  /** Yapılandırmanın nereden geldiği — log ve teşhis için. */
  source: 'explicit' | 'provider' | 'openai-fallback';
}

/** Embedding kapalıysa NEDEN kapalı olduğu — sessiz düşüşü önlemek için. */
export interface EmbedDisabledReason {
  code:
    | 'explicitly-disabled'
    | 'no-provider-support'
    | 'dimension-mismatch'
    | 'missing-key';
  message: string;
}

export type EmbedResolution =
  | { enabled: true; provider: ResolvedEmbedProvider }
  | { enabled: false; reason: EmbedDisabledReason };

/**
 * Semantik hafızanın embedding yolunu çözer.
 *
 * 2026-08-11 öncesinde `embed()` bu katmanın **tamamen dışındaydı**: seçilen
 * `LLM_PROVIDER` ne olursa olsun doğrudan api.openai.com'a gidiyor, `OPENAI_API_KEY`
 * yoksa sessizce boş vektör dönüyordu. Sonuç: önerilen `ollama` kurulumunda pgvector
 * semantik hafıza **hiç çalışmıyor** ama hiçbir yerde görünmüyordu.
 *
 * Öncelik sırası:
 *   1. EMBED_ENABLED=false          → bilinçli kapatma
 *   2. EMBED_BASE_URL (açık ayar)   → EMBED_MODEL + EMBED_DIMENSIONS ile
 *   3. Aktif LLM sağlayıcısı        → preset.embed varsa (BYOK'a bağlı yol)
 *   4. OPENAI_API_KEY               → geriye dönük uyumluluk (eski davranış)
 *   5. yok                          → kapalı + GEREKÇE
 *
 * Ortam değişkenleri:
 *   EMBED_ENABLED      — "false" ise embedding tamamen kapatılır
 *   EMBED_BASE_URL     — OpenAI-uyumlu /embeddings kökü (ör. http://localhost:11434/v1)
 *   EMBED_API_KEY      — embedding anahtarı (yoksa LLM anahtarına düşer)
 *   EMBED_MODEL        — embedding modeli
 *   EMBED_DIMENSIONS   — modelin vektör boyutu (kolonla uyuşmalı: 1536)
 */
export function resolveEmbedProvider(): EmbedResolution {
  const expected = Number(process.env.EMBED_DIMENSIONS) || EMBED_COLUMN_DIMENSIONS;

  if ((process.env.EMBED_ENABLED ?? '').toLowerCase() === 'false') {
    return {
      enabled: false,
      reason: {
        code: 'explicitly-disabled',
        message: 'EMBED_ENABLED=false — semantik hafıza bilinçli olarak kapalı.',
      },
    };
  }

  const dimensionGuard = (
    provider: ResolvedEmbedProvider,
  ): EmbedResolution => {
    if (provider.dimensions !== EMBED_COLUMN_DIMENSIONS) {
      return {
        enabled: false,
        reason: {
          code: 'dimension-mismatch',
          message:
            `Embedding modeli "${provider.model}" ${provider.dimensions} boyutlu, ` +
            `ama memory.embedding kolonu vector(${EMBED_COLUMN_DIMENSIONS}). ` +
            'Uyuşmadığı için embedding KAPATILDI (INSERT anında patlamasın diye). ' +
            'Çözüm: 1536 boyutlu bir model seç (EMBED_MODEL) ya da kolonu migration ile değiştir.',
        },
      };
    }
    return { enabled: true, provider };
  };

  // 2. Açık ayar
  const explicitBase = process.env.EMBED_BASE_URL?.trim();
  if (explicitBase) {
    return dimensionGuard({
      baseURL: explicitBase.replace(/\/+$/, ''),
      apiKey: process.env.EMBED_API_KEY ?? process.env.LLM_API_KEY ?? null,
      model: process.env.EMBED_MODEL?.trim() || 'text-embedding-3-small',
      dimensions: expected,
      source: 'explicit',
    });
  }

  // 3. Aktif LLM sağlayıcısından türet
  const id = (process.env.LLM_PROVIDER ?? 'openrouter').toLowerCase() as ProviderId;
  const preset = PRESETS[id];
  if (preset?.embed) {
    const apiKey =
      process.env.EMBED_API_KEY ??
      process.env.LLM_API_KEY ??
      (preset.keyEnv ? process.env[preset.keyEnv] ?? null : null);

    if (preset.keyEnv && !apiKey) {
      return {
        enabled: false,
        reason: {
          code: 'missing-key',
          message:
            `LLM_PROVIDER="${id}" embedding sunuyor ama anahtar yok ` +
            `(${preset.keyEnv} veya EMBED_API_KEY).`,
        },
      };
    }

    return dimensionGuard({
      baseURL: (process.env.LLM_BASE_URL ?? preset.baseURL).replace(/\/+$/, ''),
      apiKey,
      model: process.env.EMBED_MODEL?.trim() || preset.embed.model,
      dimensions: preset.embed.dimensions,
      source: 'provider',
    });
  }

  // 4. Geriye dönük uyumluluk: doğrudan OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return dimensionGuard({
      baseURL: PRESETS.openai.baseURL,
      apiKey: openaiKey,
      model: process.env.EMBED_MODEL?.trim() || 'text-embedding-3-small',
      dimensions: 1536,
      source: 'openai-fallback',
    });
  }

  // 5. Hiçbiri
  return {
    enabled: false,
    reason: {
      code: 'no-provider-support',
      message:
        `LLM_PROVIDER="${id}" OpenAI-uyumlu /embeddings sunmuyor ve yedek anahtar yok. ` +
        'Semantik hafıza KAPALI — kayıtlar anahtar kelime aramasıyla bulunur. ' +
        'Açmak için: OPENAI_API_KEY ver, ya da EMBED_BASE_URL+EMBED_MODEL ile ' +
        '1536 boyutlu bir embedding endpoint\'i tanımla.',
    },
  };
}

/**
 * Embedding durumunu açılışta **bir kez** ve görünür seviyede loglar.
 * Sessiz düşüşün panzehiri: kapalıysa WARN, açıksa INFO.
 */
export function logEmbedStatus(): EmbedResolution {
  const resolution = resolveEmbedProvider();
  if (resolution.enabled) {
    const { baseURL, model, dimensions, source } = resolution.provider;
    logger.info(
      { baseURL, model, dimensions, source, semanticMemory: 'enabled' },
      'embedding provider resolved — semantik hafıza AÇIK',
    );
  } else {
    logger.warn(
      { code: resolution.reason.code, semanticMemory: 'disabled' },
      `semantik hafıza KAPALI — ${resolution.reason.message}`,
    );
  }
  return resolution;
}
