import { describe, it, expect } from 'vitest';
import {
  AgentNameSchema,
  TaskStatusSchema,
  ActionClassSchema,
  MemoryLayerSchema,
  TaskResultSchema,
  CreateTaskSchema,
  AgentMessageSchema,
  MemoryInsertSchema,
} from './schemas.js';

/**
 * Bu şemalar HTTP sınırındaki tek doğrulama katmanı — `/api/task` gövdesi buradan
 * geçer. Testler "zod çalışıyor mu"yu değil, **sözleşmenin kendisini** sabitler:
 * ajan adları, varsayılanlar ve sayısal sınırlar sessizce değişirse burası kırılır.
 */

describe('enum sözleşmeleri', () => {
  it('tam olarak 6 ajan tanır — yeni ajan eklemek bilinçli bir karar olmalı', () => {
    expect(AgentNameSchema.options).toEqual(['core', 'brain', 'arch', 'front', 'qa', 'ops']);
  });

  it('bilinmeyen ajan adını reddeder', () => {
    expect(AgentNameSchema.safeParse('brain').success).toBe(true);
    expect(AgentNameSchema.safeParse('kage').success).toBe(false);
    expect(AgentNameSchema.safeParse('BRAIN').success).toBe(false); // büyük/küçük harf duyarlı
  });

  it('görev durumları ve aksiyon sınıfları sabittir', () => {
    expect(TaskStatusSchema.options).toContain('blocked');
    expect(ActionClassSchema.options).toEqual(['GREEN', 'YELLOW', 'RED']);
    expect(MemoryLayerSchema.options).toEqual(['episodic', 'semantic', 'procedural']);
  });
});

describe('CreateTaskSchema — /api/task gövdesi', () => {
  const gecerli = {
    projectId: 'p1',
    goal: 'Webhook retry sınırını 5 yap',
    acceptanceCriteria: ['5 hatadan sonra devre dışı kalır'],
  };

  it('eksik alanları varsayılanlarla tamamlar', () => {
    const sonuc = CreateTaskSchema.parse(gecerli);
    expect(sonuc.priority).toBe(2);
    expect(sonuc.dependencies).toEqual([]);
    expect(sonuc.parentId).toBeUndefined();
  });

  it('boş hedefi reddeder — boş görev kuyruğa girmemeli', () => {
    expect(CreateTaskSchema.safeParse({ ...gecerli, goal: '' }).success).toBe(false);
  });

  it('kabul kriteri olmayan görevi reddeder — QA doğrulayacak bir şey bulamaz', () => {
    expect(CreateTaskSchema.safeParse({ ...gecerli, acceptanceCriteria: [] }).success).toBe(false);
  });

  it('öncelik yalnızca 1|2|3 olabilir', () => {
    expect(CreateTaskSchema.safeParse({ ...gecerli, priority: 1 }).success).toBe(true);
    expect(CreateTaskSchema.safeParse({ ...gecerli, priority: 0 }).success).toBe(false);
    expect(CreateTaskSchema.safeParse({ ...gecerli, priority: 4 }).success).toBe(false);
  });
});

describe('TaskResultSchema — ajan çıktısı', () => {
  const gecerli = {
    output: 'tamam',
    artifactPaths: [],
    confidence: 0.9,
    reasoning: 'çünkü',
    tokensUsed: 120,
    costUsd: 0.004,
  };

  it('metin ya da nesne çıktı kabul eder', () => {
    expect(TaskResultSchema.safeParse(gecerli).success).toBe(true);
    expect(TaskResultSchema.safeParse({ ...gecerli, output: { ok: true } }).success).toBe(true);
  });

  it('confidence 0-1 aralığı dışına çıkamaz — QA eşikleri buna güveniyor', () => {
    expect(TaskResultSchema.safeParse({ ...gecerli, confidence: 1.01 }).success).toBe(false);
    expect(TaskResultSchema.safeParse({ ...gecerli, confidence: -0.1 }).success).toBe(false);
  });

  it('negatif maliyet ve kesirli token reddedilir — maliyet alarmı bozulmasın', () => {
    expect(TaskResultSchema.safeParse({ ...gecerli, costUsd: -1 }).success).toBe(false);
    expect(TaskResultSchema.safeParse({ ...gecerli, tokensUsed: 1.5 }).success).toBe(false);
  });
});

describe('AgentMessageSchema — event bus zarfı', () => {
  it('broadcast hedefini kabul eder', () => {
    const sonuc = AgentMessageSchema.safeParse({
      from: 'core',
      to: 'broadcast',
      type: 'log',
      payload: { msg: 'x' },
    });
    expect(sonuc.success).toBe(true);
  });

  it('bilinmeyen mesaj tipini reddeder', () => {
    const sonuc = AgentMessageSchema.safeParse({
      from: 'core',
      to: 'qa',
      type: 'gossip',
      payload: null,
    });
    expect(sonuc.success).toBe(false);
  });
});

describe('MemoryInsertSchema — pgvector kaydı', () => {
  it('metadata.agent zorunludur — ajan filtresi buna dayanıyor', () => {
    const eksik = {
      layer: 'semantic',
      content: 'bir şey',
      metadata: { confidence: 0.5, tags: [] },
    };
    expect(MemoryInsertSchema.safeParse(eksik).success).toBe(false);
  });

  it('boş içerik kaydedilemez — embed edilecek bir şey yok', () => {
    const bos = {
      layer: 'semantic',
      content: '',
      metadata: { agent: 'brain', confidence: 0.5, tags: [] },
    };
    expect(MemoryInsertSchema.safeParse(bos).success).toBe(false);
  });
});
