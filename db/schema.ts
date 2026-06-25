import { pgTable, text, timestamp, integer, jsonb, real, customType } from 'drizzle-orm/pg-core';

/** pgvector column type — stores float[] as PostgreSQL vector */
const vector = customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1536})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(',').map(Number);
  },
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  goal: text('goal').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: text('id').primaryKey(),
  parentId: text('parent_id'),
  projectId: text('project_id').references(() => projects.id),
  goal: text('goal').notNull(),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<string[]>(),
  assignedTo: text('assigned_to'),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(2),
  dependencies: jsonb('dependencies').$type<string[]>().default([]),
  result: jsonb('result'),
  refineCount: integer('refine_count').default(0),
  createdAt: timestamp('created_at').defaultNow(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
});

export const memory = pgTable('memory', {
  id: text('id').primaryKey(),
  layer: text('layer').notNull(),
  content: text('content').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  metadata: jsonb('metadata').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  lastAccessedAt: timestamp('last_accessed_at').defaultNow(),
  accessCount: integer('access_count').default(0),
});

export const agentMessages = pgTable('agent_messages', {
  id: text('id').primaryKey(),
  fromAgent: text('from_agent').notNull(),
  toAgent: text('to_agent').notNull(),
  type: text('type').notNull(),
  taskId: text('task_id'),
  payload: jsonb('payload').notNull(),
  timestamp: timestamp('timestamp').defaultNow(),
});

export const checkpoints = pgTable('checkpoints', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id),
  label: text('label').notNull(),
  state: jsonb('state').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const approvalQueue = pgTable('approval_queue', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasks.id),
  actionClass: text('action_class').notNull(),
  description: text('description').notNull(),
  proposedBy: text('proposed_by').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
  resolvedAt: timestamp('resolved_at'),
});

export const learningLog = pgTable('learning_log', {
  id: text('id').primaryKey(),
  taskId: text('task_id'),
  whatWorked: text('what_worked'),
  whatDidnt: text('what_didnt'),
  ruleExtracted: text('rule_extracted'),
  appliedToMemoryId: text('applied_to_memory_id'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const webhooks = pgTable('webhooks', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  events: jsonb('events').$type<string[]>().notNull().default([]),
  secret: text('secret'),
  active: integer('active').notNull().default(1), // 1=active, 0=paused
  failCount: integer('fail_count').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  lastTriggeredAt: timestamp('last_triggered_at'),
});

export const routingRecords = pgTable('routing_records', {
  id: text('id').primaryKey(),
  goal: text('goal').notNull(),
  assignedTo: text('assigned_to').notNull(),
  confidence: real('confidence').notNull(),
  costUsd: real('cost_usd').notNull(),
  durationMs: integer('duration_ms').notNull(),
  success: integer('success').notNull(), // 1=true, 0=false
  createdAt: timestamp('created_at').defaultNow(),
});
