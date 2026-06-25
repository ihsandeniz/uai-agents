export type AgentName = 'core' | 'brain' | 'arch' | 'front' | 'qa' | 'ops';

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting_input' | 'blocked' | 'error';

export type TaskStatus = 'pending' | 'in_progress' | 'review' | 'done' | 'rejected' | 'blocked';

export type ActionClass = 'GREEN' | 'YELLOW' | 'RED';

export type MemoryLayer = 'episodic' | 'semantic' | 'procedural';

export type MessageType = 'task_assignment' | 'task_result' | 'review' | 'question' | 'alarm' | 'log';

export interface Task {
  id: string;
  parentId?: string;
  projectId: string;
  goal: string;
  acceptanceCriteria: string[];
  assignedTo: AgentName | null;
  status: TaskStatus;
  priority: 1 | 2 | 3;
  dependencies: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: TaskResult;
  refineCount: number;
}

export interface TaskResult {
  output: string | object;
  artifactPaths: string[];
  confidence: number;
  reasoning: string;
  tokensUsed: number;
  costUsd: number;
}

export interface AgentMessage {
  id: string;
  from: AgentName;
  to: AgentName | 'broadcast';
  type: MessageType;
  taskId?: string;
  payload: unknown;
  timestamp: Date;
}

export interface MemoryEntry {
  id: string;
  layer: MemoryLayer;
  content: string;
  embedding?: number[];
  metadata: {
    sourceTaskId?: string;
    agent: AgentName;
    confidence: number;
    tags: string[];
  };
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
}

export interface AwayModePolicy {
  allowedActionClasses: ('GREEN' | 'YELLOW')[];
  costCeilingUsdPerHour: number;
  loopDetectionThreshold: number;
  maxRefinementIterations: number;
  reportIntervalMinutes: number;
}

export interface ProjectConfig {
  id: string;
  name: string;
  goal: string;
  status: 'active' | 'paused' | 'completed' | 'archived';
}
