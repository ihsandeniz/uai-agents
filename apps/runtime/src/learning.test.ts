import { describe, it, expect, vi } from 'vitest';

// --- izolasyon: bu test ne DB'ye ne de log transport'una dokunur -------------
const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('./db.js', () => ({
  db: {
    insert: () => ({ values: () => Promise.resolve() }),
    select: () => ({
      from: () => ({ orderBy: () => ({ limit: () => Promise.resolve(h.rows) }) }),
    }),
  },
}));

import { learning, LearningSystem, decayWeight } from './learning.js';

const DAY = 86_400_000;

/** Sabit saatli sistem — testler duvar saatinden bağımsız olsun. */
const T0 = Date.UTC(2026, 7, 7, 12, 0, 0);
function sys(opts: Partial<{ halfLifeDays: number; minWeight: number; maxRecords: number }> = {}) {
  return new LearningSystem({ halfLifeDays: 30, minWeight: 0.01, now: () => T0, ...opts });
}
function at(daysAgo: number) {
  return new Date(T0 - daysAgo * DAY);
}

describe('decay — davranış (canlı singleton, gerçek saat)', () => {
  it('90 gün önceki başarı, dünkü başarısızlıkla aynı ağırlıkta olmamalı', () => {
    // Bu test decay YOKKEN kırmızıdır: ağırlıksız ortalama successRate = 0.5 verir.
    learning.record({
      goal: 'eski görev raporlama modülü',
      assignedTo: 'front',
      confidence: 0.9,
      costUsd: 0.01,
      durationMs: 1000,
      success: true,
      recordedAt: new Date(Date.now() - 90 * DAY),
    });
    learning.record({
      goal: 'yeni görev raporlama modülü',
      assignedTo: 'front',
      confidence: 0.9,
      costUsd: 0.01,
      durationMs: 1000,
      success: false,
      recordedAt: new Date(Date.now() - 1 * DAY),
    });

    const summary = learning.getSummary();
    // 30 günlük yarı ömürde eski kaydın ağırlığı 2^-3 = 0.125 →
    // successRate ≈ 0.125 / 1.125 ≈ 0.11, yani 0.5 değil.
    expect(summary.front.successRate).toBeLessThan(0.2);
  });
});

describe('decayWeight', () => {
  it('yaş 0 iken 1, bir yarı ömürde 0.5, iki yarı ömürde 0.25', () => {
    expect(decayWeight(0, 30)).toBe(1);
    expect(decayWeight(30 * DAY, 30)).toBeCloseTo(0.5, 10);
    expect(decayWeight(60 * DAY, 30)).toBeCloseTo(0.25, 10);
  });

  it('halfLifeDays <= 0 decay’i kapatır (kaçış kapısı)', () => {
    expect(decayWeight(365 * DAY, 0)).toBe(1);
  });

  it('gelecek tarihli kayıt 1’den büyük ağırlık almaz', () => {
    expect(decayWeight(-10 * DAY, 30)).toBe(1);
  });
});

describe('LearningSystem — ağırlıklı istatistik', () => {
  it('getSummary ağırlıklı successRate üretir', () => {
    const ls = sys();
    ls.record({ goal: 'a bir', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: true, recordedAt: at(90) });
    ls.record({ goal: 'a iki', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: false, recordedAt: at(0) });

    const s = ls.getSummary().qa;
    expect(s.tasks).toBe(2);                       // ham sayım aynen kalır
    expect(s.successRate).toBeCloseTo(0.125 / 1.125, 2);
    expect(s.effectiveTasks).toBeCloseTo(1.13, 2); // 1 + 0.125
  });

  it('decay kapalıyken (halfLifeDays: 0) eski ağırlıksız davranışa döner', () => {
    const ls = sys({ halfLifeDays: 0 });
    ls.record({ goal: 'a bir', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: true, recordedAt: at(90) });
    ls.record({ goal: 'a iki', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: false, recordedAt: at(0) });

    expect(ls.getSummary().qa.successRate).toBe(0.5);
  });

  it('recordedAt verilmezse kayıt "şimdi" sayılır (çağıran kod değişmedi)', () => {
    const ls = sys();
    ls.record({ goal: 'zamansiz kayit', assignedTo: 'ops', confidence: 0.8, costUsd: 0.01, durationMs: 100, success: true });
    const s = ls.getSummary().ops;
    expect(s.successRate).toBe(1);
    expect(s.effectiveTasks).toBe(1);
  });
});

describe('LearningSystem — yönlendirme', () => {
  it('taze veri, hacimli ama eski veriyi yener', () => {
    const ls = sys();
    // 6 eski başarı: front
    for (let i = 0; i < 6; i++) {
      ls.record({ goal: 'veritabani migration yazilacak', assignedTo: 'front', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: true, recordedAt: at(120) });
    }
    // 2 taze başarı: brain
    for (let i = 0; i < 2; i++) {
      ls.record({ goal: 'veritabani migration yazilacak', assignedTo: 'brain', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: true, recordedAt: at(0) });
    }

    expect(ls.suggestAgent('veritabani migration yazilacak')).toBe('brain');
  });

  it('yalnızca çok eski veri varsa öneri yapılmaz (LLM yönlendirmesine düşer)', () => {
    const ls = sys();
    for (let i = 0; i < 10; i++) {
      ls.record({ goal: 'eski konu hakkinda islem', assignedTo: 'front', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: true, recordedAt: at(300) });
    }
    expect(ls.suggestAgent('eski konu hakkinda islem')).toBeNull();
  });
});

describe('LearningSystem — budama ve geriye dönük uyum', () => {
  it('ağırlığı minWeight altına düşen kayıtlar buffer’dan atılır', () => {
    const ls = sys({ halfLifeDays: 1 }); // minWeight 0.01 → ~6.6 gün ufuk
    ls.record({ goal: 'cok eski', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: true, recordedAt: at(30) });
    ls.record({ goal: 'taze', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: true, recordedAt: at(0) });

    expect(ls.getSummary().qa.tasks).toBe(1);
  });

  it('loadFromDb createdAt sütununu okur', async () => {
    h.rows = [
      { goal: 'db eski', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: 1, createdAt: at(60) },
      { goal: 'db taze', assignedTo: 'qa', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: 0, createdAt: at(0) },
    ];
    const ls = sys();
    await ls.loadFromDb();

    const s = ls.getSummary().qa;
    expect(s.tasks).toBe(2);
    expect(s.successRate).toBeCloseTo(0.25 / 1.25, 2); // eski başarı 2 yarı ömür → 0.25
  });

  it('createdAt null olan eski satırlar okunabilir kalır (şema migration’ı gerekmez)', async () => {
    h.rows = [
      { goal: 'damgasiz satir', assignedTo: 'ops', confidence: 0.9, costUsd: 0.01, durationMs: 100, success: 1, createdAt: null },
    ];
    const ls = sys();
    await ls.loadFromDb();

    expect(ls.getSummary().ops.tasks).toBe(1);
  });
});
