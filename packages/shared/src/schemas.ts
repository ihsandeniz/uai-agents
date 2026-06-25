import { z } from 'zod';

export const AgentNameSchema = z.enum(['core', 'brain', 'arch', 'front', 'qa', 'ops']);

export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'review', 'done', 'rejected', 'blocked']);

export const ActionClassSchema = z.enum(['GREEN', 'YELLOW', 'RED']);

export const MemoryLayerSchema = z.enum(['episodic', 'semantic', 'procedural']);

export const TaskResultSchema = z.object({
  output: z.union([z.string(), z.record(z.unknown())]),
  artifactPaths: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  tokensUsed: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});

export const CreateTaskSchema = z.object({
  projectId: z.string(),
  goal: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).min(1),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  dependencies: z.array(z.string()).default([]),
  parentId: z.string().optional(),
});

export const AgentMessageSchema = z.object({
  from: AgentNameSchema,
  to: z.union([AgentNameSchema, z.literal('broadcast')]),
  type: z.enum(['task_assignment', 'task_result', 'review', 'question', 'alarm', 'log']),
  taskId: z.string().optional(),
  payload: z.unknown(),
});

export const MemoryInsertSchema = z.object({
  layer: MemoryLayerSchema,
  content: z.string().min(1),
  metadata: z.object({
    sourceTaskId: z.string().optional(),
    agent: AgentNameSchema,
    confidence: z.number().min(0).max(1),
    tags: z.array(z.string()),
  }),
});
