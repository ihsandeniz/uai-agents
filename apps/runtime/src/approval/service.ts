import type { ActionClass, AgentName } from '@uai/shared';
import { db } from '../db.js';
import { approvalQueue } from '@uai/db/schema';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { logger } from '../logger.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  taskId: string;
  actionClass: ActionClass;
  description: string;
  proposedBy: AgentName;
  status: ApprovalStatus;
  createdAt: Date;
}

/** Classify an action based on its description */
export function classifyAction(description: string): ActionClass {
  const lower = description.toLowerCase();

  // RED: destructive, irreversible, external
  const redPatterns = [
    'delete', 'remove', 'drop', 'sil', 'kaldır',
    'deploy', 'push', 'publish', 'yayınla',
    'send email', 'send message', 'gönder',
    'payment', 'ödeme', 'billing',
    'production', 'prod',
  ];
  if (redPatterns.some((p) => lower.includes(p))) return 'RED';

  // YELLOW: modifying, creating, external reads
  const yellowPatterns = [
    'create', 'update', 'modify', 'oluştur', 'güncelle', 'değiştir',
    'write file', 'dosya yaz',
    'api call', 'external', 'fetch', 'dış',
    'install', 'kur',
    'config', 'ayar',
  ];
  if (yellowPatterns.some((p) => lower.includes(p))) return 'YELLOW';

  // GREEN: read-only, analysis, internal
  return 'GREEN';
}

/** Request approval for an action */
export async function requestApproval(
  taskId: string,
  actionClass: ActionClass,
  description: string,
  proposedBy: AgentName,
): Promise<ApprovalRequest> {
  const id = ulid();
  const now = new Date();

  await db.insert(approvalQueue).values({
    id,
    taskId,
    actionClass,
    description,
    proposedBy,
    status: 'pending',
    createdAt: now,
  });

  logger.info({ id, actionClass, proposedBy, description: description.slice(0, 60) }, 'approval requested');

  return { id, taskId, actionClass, description, proposedBy, status: 'pending', createdAt: now };
}

/** Resolve an approval request */
export async function resolveApproval(id: string, approved: boolean): Promise<void> {
  await db.update(approvalQueue).set({
    status: approved ? 'approved' : 'rejected',
    resolvedAt: new Date(),
  }).where(eq(approvalQueue.id, id));

  logger.info({ id, approved }, 'approval resolved');
}

/** Get pending approvals */
export async function getPendingApprovals(): Promise<ApprovalRequest[]> {
  const rows = await db
    .select()
    .from(approvalQueue)
    .where(eq(approvalQueue.status, 'pending'));

  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId ?? '',
    actionClass: r.actionClass as ActionClass,
    description: r.description,
    proposedBy: r.proposedBy as AgentName,
    status: r.status as ApprovalStatus,
    createdAt: r.createdAt!,
  }));
}

/** Check if an action needs approval based on class */
export function needsApproval(actionClass: ActionClass): boolean {
  return actionClass === 'RED';
}

/** Check if an action needs notification */
export function needsNotification(actionClass: ActionClass): boolean {
  return actionClass === 'YELLOW' || actionClass === 'RED';
}
