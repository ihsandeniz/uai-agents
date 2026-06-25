import type { AgentName, AgentStatus, TaskStatus } from './types.js';

export type DashboardEventType =
  | 'agent_status'
  | 'task_update'
  | 'message'
  | 'memory_write'
  | 'approval_request'
  | 'cost_update'
  | 'system_health';

export interface DashboardEvent {
  type: DashboardEventType;
  agent?: AgentName;
  taskId?: string;
  payload: unknown;
  timestamp: Date;
}

export interface AgentStatusEvent {
  type: 'agent_status';
  agent: AgentName;
  payload: {
    status: AgentStatus;
    currentTaskId?: string;
  };
  timestamp: Date;
}

export interface TaskUpdateEvent {
  type: 'task_update';
  taskId: string;
  payload: {
    status: TaskStatus;
    assignedTo?: AgentName;
  };
  timestamp: Date;
}

export interface SystemHealthEvent {
  type: 'system_health';
  payload: {
    db: boolean;
    redis: boolean;
    uptime: number;
    activeAgents: number;
  };
  timestamp: Date;
}
