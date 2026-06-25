import type { AgentName, MemoryLayer } from '@uai/shared';
import { db } from '../db.js';
import { memory } from '@uai/db/schema';
import { eq, and, desc, sql, ilike } from 'drizzle-orm';
import { ulid } from 'ulid';
import { logger } from '../logger.js';
import { embed } from '../llm/client.js';

export interface SaveMemoryOpts {
  layer: MemoryLayer;
  content: string;
  agent: AgentName;
  sourceTaskId?: string;
  confidence?: number;
  tags?: string[];
}

export interface RecallOpts {
  query: string;
  layer?: MemoryLayer;
  agent?: AgentName;
  limit?: number;
}

export interface MemoryRecord {
  id: string;
  layer: MemoryLayer;
  content: string;
  metadata: {
    sourceTaskId?: string;
    agent: AgentName;
    confidence: number;
    tags: string[];
  };
  createdAt: Date;
  accessCount: number;
}

/** Save a new memory entry */
export async function saveMemory(opts: SaveMemoryOpts): Promise<string> {
  const id = ulid();
  const now = new Date();

  // Generate semantic embedding (no-op if OPENAI_API_KEY not set)
  const embedding = await embed(opts.content).catch(() => [] as number[]);

  await db.insert(memory).values({
    id,
    layer: opts.layer,
    content: opts.content,
    embedding: embedding.length > 0 ? embedding : undefined,
    metadata: {
      sourceTaskId: opts.sourceTaskId,
      agent: opts.agent,
      confidence: opts.confidence ?? 0.8,
      tags: opts.tags ?? [],
    },
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
  });

  logger.info({ id, layer: opts.layer, agent: opts.agent, hasEmbedding: embedding.length > 0 }, 'memory saved');
  return id;
}

/** Recall memories — vector similarity search with keyword fallback */
export async function recallMemory(opts: RecallOpts): Promise<MemoryRecord[]> {
  const limit = opts.limit ?? 10;

  // Base filter conditions (layer, agent)
  const baseConditions = [];
  if (opts.layer) baseConditions.push(eq(memory.layer, opts.layer));
  if (opts.agent) baseConditions.push(sql`${memory.metadata}->>'agent' = ${opts.agent}`);

  let rows: typeof memory.$inferSelect[] = [];
  let searchMode = 'keyword';

  // Try vector search if query provided
  if (opts.query) {
    const queryEmbedding = await embed(opts.query).catch(() => [] as number[]);

    if (queryEmbedding.length > 0) {
      const embeddingStr = `[${queryEmbedding.join(',')}]`;
      rows = await db
        .select()
        .from(memory)
        .where(and(...baseConditions, sql`${memory.embedding} IS NOT NULL`))
        .orderBy(sql`${memory.embedding} <=> ${embeddingStr}::vector`)
        .limit(limit);
      searchMode = 'vector';
    }

    // Fallback: keyword search if no vector results
    if (rows.length === 0) {
      const kwConditions = [...baseConditions, ilike(memory.content, `%${opts.query}%`)];
      rows = await db
        .select()
        .from(memory)
        .where(and(...kwConditions))
        .orderBy(desc(memory.createdAt))
        .limit(limit);
      searchMode = 'keyword';
    }
  } else {
    rows = await db
      .select()
      .from(memory)
      .where(baseConditions.length > 0 ? and(...baseConditions) : undefined)
      .orderBy(desc(memory.createdAt))
      .limit(limit);
  }

  // Update access counts in background
  for (const row of rows) {
    db.update(memory)
      .set({ lastAccessedAt: new Date(), accessCount: sql`${memory.accessCount} + 1` })
      .where(eq(memory.id, row.id))
      .catch(() => {});
  }

  logger.debug({ query: opts.query, searchMode, found: rows.length }, 'memory recall');

  return rows.map((r) => ({
    id: r.id,
    layer: r.layer as MemoryLayer,
    content: r.content,
    metadata: r.metadata as MemoryRecord['metadata'],
    createdAt: r.createdAt!,
    accessCount: (r.accessCount ?? 0) + 1,
  }));
}

/** Get all memories for a specific agent */
export async function getAgentMemories(agent: AgentName, layer?: MemoryLayer): Promise<MemoryRecord[]> {
  return recallMemory({
    query: '',
    layer,
    agent,
    limit: 50,
  });
}

/** Delete a memory by ID */
export async function deleteMemory(id: string): Promise<boolean> {
  const result = await db.delete(memory).where(eq(memory.id, id));
  logger.info({ id }, 'memory deleted');
  return true;
}
