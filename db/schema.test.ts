import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, 'migrations');

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n')
    .toLowerCase();
}

/**
 * Drift nöbetçisi.
 *
 * 2026-08-08'de `webhooks` tablosu ve `memory.embedding` kolonu şemada vardı ama
 * migration'larda yoktu — sıfırdan kurulan bir DB onları hiç almıyordu. Teşhis
 * ikinci turda düzeldi (eksik olan `meta/` snapshot'larıydı), ama o tura kadar
 * kimse fark etmemişti çünkü **hiçbir şey kontrol etmiyordu**.
 *
 * Bu testler DB'ye bağlanmaz — şema tanımı ile migration SQL'ini metin düzeyinde
 * karşılaştırır. Ucuz, ağsız, CI'da koşar.
 */

describe('şema ↔ migration drift', () => {
  const sql = migrationSql();

  const tables = Object.values(schema)
    .filter((v): v is typeof schema.projects => typeof v === 'object' && v !== null && Symbol.for('drizzle:Name') in v)
    .map((t) => getTableConfig(t));

  it('tarayıcı gerçekten tabloları buluyor — 9 tablonun tamamı', () => {
    // Bu satır olmadan yukarıdaki filtre sessizce 0 tablo bulup testleri
    // "yeşil ama hiçbir şey ölçmeyen" hâle getirebilir. Sayı ve isimler kilitli.
    expect(tables.map((t) => t.name).sort()).toEqual([
      'agent_messages',
      'approval_queue',
      'checkpoints',
      'learning_log',
      'memory',
      'projects',
      'routing_records',
      'tasks',
      'webhooks',
    ]);
  });

  it('şemadaki her tablo migration SQL\'inde geçiyor', () => {
    const eksik = tables.filter((t) => !sql.includes(`"${t.name}"`));
    expect(eksik.map((t) => t.name)).toEqual([]);
  });

  it('şemadaki her kolon migration SQL\'inde geçiyor', () => {
    const eksik: string[] = [];
    for (const t of tables) {
      for (const c of t.columns) {
        if (!sql.includes(`"${c.name}"`)) eksik.push(`${t.name}.${c.name}`);
      }
    }
    expect(eksik).toEqual([]);
  });

  it('her migration dosyasının meta/ altında snapshot\'ı var', () => {
    // 08-08 drift'inin gerçek kök nedeni buydu: 0002 ve 0003 snapshot'ları eksikti,
    // drizzle de var olan şemayı "yeni" sanıp durmadan migration üretiyordu.
    const sqlDosyalari = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const snapshotlar = readdirSync(join(MIGRATIONS, 'meta')).filter((f) => f.endsWith('_snapshot.json'));
    expect(sqlDosyalari.length).toBeGreaterThan(0);
    const eksik = sqlDosyalari
      .map((f) => f.slice(0, 4))
      .filter((n) => !snapshotlar.some((s) => s.startsWith(n)));
    expect(eksik).toEqual([]);
  });
});

describe('pgvector sözleşmesi', () => {
  it('memory.embedding vector(1536) — embed katmanı bu boyuta kilitli', () => {
    const { columns } = getTableConfig(schema.memory);
    const embedding = columns.find((c) => c.name === 'embedding');
    expect(embedding).toBeDefined();
    expect(embedding!.getSQLType()).toBe('vector(1536)');
  });

  it('hnsw indeksi şemada tanımlı — yalnız ham SQL\'de kalmamalı', () => {
    const { indexes } = getTableConfig(schema.memory);
    const isim = indexes.map((i) => i.config.name);
    expect(isim).toContain('memory_embedding_idx');
  });

  it('vector customType değeri PostgreSQL biçimine çevirir ve geri okur', () => {
    const { columns } = getTableConfig(schema.memory);
    const embedding = columns.find((c) => c.name === 'embedding')!;
    const driverValue = embedding.mapToDriverValue([1, 2.5, -3]) as string;
    expect(driverValue).toBe('[1,2.5,-3]');
    expect(embedding.mapFromDriverValue('[1,2.5,-3]')).toEqual([1, 2.5, -3]);
  });
});

describe('RLS dosyası', () => {
  it('journal DIŞINDA duruyor — sıfır DB\'de RLS kapalı gelir (bilinçli)', () => {
    // Bu test bir davranışı savunmuyor, bir GERÇEĞİ sabitliyor: dosya `manual/`
    // altındadır ve `pnpm db:migrate` onu uygulamaz. Biri journal'a alırsa test
    // kırılır ve kararın bilinçli olduğunu görürüz.
    const manual = readdirSync(join(MIGRATIONS, 'manual'));
    expect(manual).toContain('rls_policies.sql');

    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    expect(journal.entries.some((e) => e.tag.includes('rls'))).toBe(false);
  });
});
