import { db } from '../db.js';
import { projects, tasks as tasksTable } from '@uai/db/schema';
import { eq, desc } from 'drizzle-orm';
import { ulid } from 'ulid';
import { logger } from '../logger.js';

export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface ProjectRecord {
  id: string;
  name: string;
  goal: string;
  status: ProjectStatus;
  createdAt: Date | null;
}

/** Ensure the built-in 'default' project row exists */
export async function ensureDefaultProject(): Promise<void> {
  const existing = await db.select().from(projects).where(eq(projects.id, 'default'));
  if (existing.length === 0) {
    await db.insert(projects).values({
      id: 'default',
      name: 'Default Project',
      goal: 'General-purpose task execution',
      status: 'active',
    });
    logger.info('default project created');
  }
}

export async function createProject(name: string, goal: string): Promise<ProjectRecord> {
  const id = ulid();
  await db.insert(projects).values({ id, name, goal, status: 'active' });
  logger.info({ id, name }, 'project created');
  return { id, name, goal, status: 'active', createdAt: new Date() };
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    goal: r.goal,
    status: r.status as ProjectStatus,
    createdAt: r.createdAt,
  }));
}

export async function getProject(id: string): Promise<(ProjectRecord & { tasks: unknown[] }) | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id));
  if (rows.length === 0) return null;

  const taskRows = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.projectId, id))
    .orderBy(desc(tasksTable.createdAt))
    .limit(50);

  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    goal: r.goal,
    status: r.status as ProjectStatus,
    createdAt: r.createdAt,
    tasks: taskRows,
  };
}

export async function updateProjectStatus(id: string, status: ProjectStatus): Promise<boolean> {
  const result = await db.update(projects).set({ status }).where(eq(projects.id, id));
  logger.info({ id, status }, 'project status updated');
  return true;
}
