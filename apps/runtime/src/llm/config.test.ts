import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveProvider, resolveEmbedProvider, EMBED_COLUMN_DIMENSIONS } from './config.js';

/**
 * 2026-08-11 doc-sync bulgusu: `embed()` BYOK katmanının tamamen dışındaydı —
 * `LLM_PROVIDER` ne olursa olsun api.openai.com'a gidiyor, anahtar yoksa
 * **sessizce** boş vektör dönüyordu. Önerilen `ollama` kurulumunda semantik
 * hafıza aylarca ölüydü ve hiçbir yerde görünmüyordu.
 *
 * Bu testler iki şeyi sabitler:
 *   1. embed artık sağlayıcıya bağlı çözülüyor
 *   2. kapalıysa GEREKÇE dönüyor (sessiz düşüş yok)
 */

const KORUNAN = [
  'LLM_PROVIDER',
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'EMBED_ENABLED',
  'EMBED_BASE_URL',
  'EMBED_API_KEY',
  'EMBED_MODEL',
  'EMBED_DIMENSIONS',
] as const;

let yedek: Record<string, string | undefined>;

beforeEach(() => {
  yedek = {};
  for (const k of KORUNAN) {
    yedek[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KORUNAN) {
    if (yedek[k] === undefined) delete process.env[k];
    else process.env[k] = yedek[k];
  }
});

describe('resolveProvider — sohbet katmanı (regresyon koruması)', () => {
  it('varsayılan openrouter, anahtar zorunlu', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const p = resolveProvider();
    expect(p.id).toBe('openrouter');
    expect(p.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(p.resolve('sonnet').modelName).toBe('anthropic/claude-sonnet-4-6');
  });

  it('ollama anahtarsız çalışır', () => {
    process.env.LLM_PROVIDER = 'ollama';
    const p = resolveProvider();
    expect(p.apiKey).toBeNull();
    expect(p.baseURL).toBe('http://localhost:11434/v1');
  });

  it('anahtarsız ücretli sağlayıcı hata verir — sessizce devam etmez', () => {
    process.env.LLM_PROVIDER = 'openai';
    expect(() => resolveProvider()).toThrow(/API anahtarı gerekli/);
  });

  it('bilinmeyen sağlayıcı hata verir', () => {
    process.env.LLM_PROVIDER = 'sihirli-model';
    expect(() => resolveProvider()).toThrow(/Bilinmeyen LLM_PROVIDER/);
  });
});

describe('resolveEmbedProvider — kapalıysa GEREKÇE döner', () => {
  it('openrouter + anahtar yok → kapalı, sebebi "no-provider-support"', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(false);
    if (r.enabled) return;
    expect(r.reason.code).toBe('no-provider-support');
    // Gerekçe kullanıcıya NE YAPACAĞINI söylemeli — kuru bir "disabled" yetmez.
    expect(r.reason.message).toMatch(/OPENAI_API_KEY|EMBED_BASE_URL/);
  });

  it('ollama → 768 boyut, vector(1536) ile uyuşmuyor → kapalı + net sebep', () => {
    process.env.LLM_PROVIDER = 'ollama';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(false);
    if (r.enabled) return;
    expect(r.reason.code).toBe('dimension-mismatch');
    expect(r.reason.message).toContain('768');
    expect(r.reason.message).toContain(String(EMBED_COLUMN_DIMENSIONS));
  });

  it('EMBED_ENABLED=false → bilinçli kapatma ayırt edilebilir', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.EMBED_ENABLED = 'false';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(false);
    if (r.enabled) return;
    expect(r.reason.code).toBe('explicitly-disabled');
  });
});

describe('resolveEmbedProvider — açıkken doğru yere gider', () => {
  it('LLM_PROVIDER=openai → embed de OpenAI, ayrı anahtar istemez (BYOK bağlandı)', () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(true);
    if (!r.enabled) return;
    expect(r.provider.source).toBe('provider');
    expect(r.provider.baseURL).toBe('https://api.openai.com/v1');
    expect(r.provider.model).toBe('text-embedding-3-small');
    expect(r.provider.dimensions).toBe(1536);
  });

  it('openrouter + OPENAI_API_KEY → eski davranış korunur (geriye uyum)', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(true);
    if (!r.enabled) return;
    expect(r.provider.source).toBe('openai-fallback');
    expect(r.provider.apiKey).toBe('sk-test');
  });

  it('EMBED_BASE_URL her şeyi ezer — self-host embedding yolu', () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.EMBED_BASE_URL = 'http://localhost:8080/v1/';
    process.env.EMBED_MODEL = 'bge-m3';
    process.env.EMBED_API_KEY = 'gizli';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(true);
    if (!r.enabled) return;
    expect(r.provider.source).toBe('explicit');
    expect(r.provider.baseURL).toBe('http://localhost:8080/v1'); // sondaki / kırpılır
    expect(r.provider.model).toBe('bge-m3');
    expect(r.provider.apiKey).toBe('gizli');
  });

  it('açık ayarda bile boyut uyuşmazlığı geçmez', () => {
    process.env.EMBED_BASE_URL = 'http://localhost:8080/v1';
    process.env.EMBED_DIMENSIONS = '768';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(false);
    if (r.enabled) return;
    expect(r.reason.code).toBe('dimension-mismatch');
  });

  it('gemini → 768, sessizce KABUL EDİLMEZ (INSERT anında patlamasın)', () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'g-test';
    const r = resolveEmbedProvider();
    expect(r.enabled).toBe(false);
  });
});
