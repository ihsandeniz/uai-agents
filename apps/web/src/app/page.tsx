'use client';

import { useEffect, useState, useRef } from 'react';

interface DashboardEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface AgentInfo {
  name: string;
  status: string;
  cost: number;
}

interface AwayStatus {
  active: boolean;
  elapsedMinutes?: number;
  totalCost?: number;
  tasksCompleted?: number;
  costCeiling?: number;
}

interface LearningData {
  [agent: string]: {
    tasks: number;
    successRate: number;
    avgConfidence: number;
    avgCost: number;
    topCategories: string[];
  };
}

interface TaskRow {
  id: string;
  goal: string | null;
  status: string;
  assignedTo: string | null;
  createdAt: string;
  result: { confidence?: number; costUsd?: number } | null;
}

interface ApprovalRequest {
  id: string;
  taskId: string;
  actionClass: 'RED' | 'YELLOW' | 'GREEN';
  description: string;
  proposedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

const RUNTIME_URL = process.env.NEXT_PUBLIC_RUNTIME_URL || 'http://localhost:3000';

const AGENT_META: Record<string, { emoji: string; color: string; role: string }> = {
  core: { emoji: '\u2699', color: 'var(--cyan)', role: 'Orchestrator' },
  brain: { emoji: '\uD83E\uDDE0', color: '#a855f7', role: 'Reasoning' },
  arch: { emoji: '\uD83C\uDFD7', color: 'var(--gold)', role: 'Architecture' },
  front: { emoji: '\uD83C\uDFA8', color: '#00ff88', role: 'Frontend' },
  ops: { emoji: '\u26A1', color: '#3388ff', role: 'Operations' },
  qa: { emoji: '\u2713', color: '#00d4aa', role: 'Quality' },
};

function getStatusClass(status: string): string {
  if (status === 'idle') return 'idle';
  if (status === 'running' || status === 'working') return 'working';
  if (status === 'error' || status === 'failed') return 'error';
  return 'idle';
}

export default function Dashboard() {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([
    { name: 'core', status: 'idle', cost: 0 },
    { name: 'brain', status: 'idle', cost: 0 },
    { name: 'arch', status: 'idle', cost: 0 },
    { name: 'front', status: 'idle', cost: 0 },
    { name: 'ops', status: 'idle', cost: 0 },
    { name: 'qa', status: 'idle', cost: 0 },
  ]);
  const [stats, setStats] = useState({
    tasksCompleted: 0,
    totalCost: 0,
    totalEvents: 0,
    uptime: 0,
  });
  const [queueStats, setQueueStats] = useState({ pending: 0, running: 0, completed: 0, failed: 0, avgDurationMs: 0, paused: false, totalCost: 0 });
  const [costAlert, setCostAlert] = useState(false);

  const [taskInput, setTaskInput] = useState('');
  const [taskLoading, setTaskLoading] = useState(false);
  const [awayInput, setAwayInput] = useState('');
  const [awayStatus, setAwayStatus] = useState<AwayStatus>({ active: false });
  const [taskHistory, setTaskHistory] = useState<TaskRow[]>([]);
  const [activeTab, setActiveTab] = useState<'events' | 'tasks' | 'approvals'>('events');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskRow & { result?: { output?: string; confidence?: number; reasoning?: string; costUsd?: number } } | null>(null);
  const [learningData, setLearningData] = useState<LearningData>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const es = new EventSource(`${RUNTIME_URL}/api/stream`);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as DashboardEvent;

        setEvents((prev) => [event, ...prev].slice(0, 100));
        setStats((prev) => ({ ...prev, totalEvents: prev.totalEvents + 1 }));

        if (event.type === 'agent_status') {
          const name = event.data.agent as string;
          const status = event.data.status as string;
          if (name) {
            setAgents((prev) =>
              prev.map((a) => (a.name === name ? { ...a, status } : a))
            );
          }
        }

        if (event.type === 'task_completed') {
          const cost = (event.data.cost as number) || 0;
          setStats((prev) => ({
            ...prev,
            tasksCompleted: prev.tasksCompleted + 1,
            totalCost: prev.totalCost + cost,
          }));
          fetchTasks();
        }

        if (event.type === 'cost_alert') {
          setCostAlert(true);
        }
      } catch {
        // ignore
      }
    };

    const pollInterval = setInterval(async () => {
      try {
        const [healthRes, awayRes, agentsRes, queueRes, learnRes, approvalsRes] = await Promise.all([
          fetch(`${RUNTIME_URL}/health`),
          fetch(`${RUNTIME_URL}/api/away/status`),
          fetch(`${RUNTIME_URL}/api/agents`),
          fetch(`${RUNTIME_URL}/api/queue`),
          fetch(`${RUNTIME_URL}/api/learning`),
          fetch(`${RUNTIME_URL}/api/approvals`),
        ]);
        const health = await healthRes.json();
        const away = await awayRes.json();
        const agentData = await agentsRes.json();
        const qData = await queueRes.json();
        const learnData = await learnRes.json();
        if (approvalsRes.ok) setApprovals(await approvalsRes.json());

        setStats((prev) => ({ ...prev, uptime: Math.round(health.uptime) }));
        setAwayStatus(away);
        setQueueStats(qData);
        setLearningData(learnData);
        setConnected(true);

        setAgents((prev) =>
          prev.map((a) => {
            const server = agentData[a.name];
            return server ? { ...a, status: server.status, cost: server.cost } : a;
          })
        );
      } catch {
        setConnected(false);
      }
    }, 5_000);

    fetchTasks();

    return () => {
      es.close();
      clearInterval(pollInterval);
    };
  }, []);

  async function fetchTasks() {
    try {
      const res = await fetch(`${RUNTIME_URL}/api/tasks?limit=15`);
      const data = await res.json();
      setTaskHistory(data);
    } catch {
      // ignore
    }
  }

  async function fetchTaskDetail(id: string) {
    try {
      const res = await fetch(`${RUNTIME_URL}/api/tasks/${id}`);
      const data = await res.json();
      setSelectedTask(data);
    } catch {
      // ignore
    }
  }

  async function submitTask() {
    if (!taskInput.trim() || taskLoading) return;
    setTaskLoading(true);
    try {
      await fetch(`${RUNTIME_URL}/api/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: taskInput }),
      });
      setTaskInput('');
      inputRef.current?.focus();
    } catch {
      // ignore
    } finally {
      setTaskLoading(false);
    }
  }

  async function startAway() {
    const goals = awayInput.split(';').map((g) => g.trim()).filter(Boolean);
    if (!goals.length) return;
    try {
      await fetch(`${RUNTIME_URL}/api/away/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goals }),
      });
      setAwayInput('');
    } catch {
      // ignore
    }
  }

  async function stopAway() {
    try {
      await fetch(`${RUNTIME_URL}/api/away/stop`, { method: 'POST' });
    } catch {
      // ignore
    }
  }

  async function toggleQueuePause() {
    const endpoint = queueStats.paused ? 'resume' : 'pause';
    try {
      await fetch(`${RUNTIME_URL}/api/queue/${endpoint}`, { method: 'POST' });
    } catch {
      // ignore
    }
  }

  async function retryTask(taskId: string) {
    try {
      await fetch(`${RUNTIME_URL}/api/task/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      fetchTasks();
    } catch {
      // ignore
    }
  }

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;

  return (
    <div className="dashboard-wrapper">
      {/* TOPBAR */}
      <div className="topbar">
        <div className="topbar-brand">
          <div className="brand-dot"></div>
          <span className="brand-text">UAI Agents</span>
          <span className="brand-version">v1.0</span>
        </div>
        <div className="topbar-controls">
          {awayStatus.active && <span className="away-badge">AWAY MODE</span>}
          {queueStats.paused && <span className="queue-paused-badge">PAUSED</span>}
          <span className={`connection-dot ${connected ? 'connected' : 'disconnected'}`}></span>
          <span className="connection-status" style={{ color: connected ? 'var(--status-success)' : 'var(--status-error)' }}>
            {connected ? 'Live' : 'Offline'}
          </span>
        </div>
      </div>

      {/* MAIN LAYOUT: Sidebar + Content */}
      <div className="dashboard-layout">
        {/* SIDEBAR: Agent Cards */}
        <aside className="sidebar">
          <div className="sidebar-title">
            <span className="section-title-line"></span>
            Agents
          </div>
          <div className="agent-cards">
            {agents.map((agent) => {
              const meta = AGENT_META[agent.name] || { emoji: '\uD83E\uDD16', color: 'var(--cyan)', role: 'Agent' };
              const statusClass = getStatusClass(agent.status);
              return (
                <div key={agent.name} className={`agent-card ${statusClass}`}>
                  <div className="agent-header">
                    <span className="agent-emoji" style={{ color: meta.color }}>{meta.emoji}</span>
                    <div className="agent-info">
                      <span className="agent-name">{agent.name}</span>
                      <span className="agent-role">{meta.role}</span>
                    </div>
                    <span className={`agent-status-dot ${statusClass}`}></span>
                  </div>
                  <div className="agent-card-footer">
                    <span className={`agent-status-badge ${statusClass}`}>
                      {agent.status}
                    </span>
                    <span className="agent-cost gold-accent">${agent.cost.toFixed(4)}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* AWAY MODE in sidebar */}
          {awayStatus.active ? (
            <div className="away-sidebar-card">
              <div className="section-subtitle gold-accent">Away Mode</div>
              <div className="away-mini-stats">
                <div className="away-mini-stat">
                  <span className="away-mini-value">{awayStatus.elapsedMinutes ?? 0}m</span>
                  <span className="away-mini-label">Time</span>
                </div>
                <div className="away-mini-stat">
                  <span className="away-mini-value">{awayStatus.tasksCompleted ?? 0}</span>
                  <span className="away-mini-label">Done</span>
                </div>
                <div className="away-mini-stat">
                  <span className="away-mini-value gold-accent">${(awayStatus.totalCost ?? 0).toFixed(3)}</span>
                  <span className="away-mini-label">Cost</span>
                </div>
              </div>
              <button className="stop-away-btn" onClick={stopAway}>Stop</button>
            </div>
          ) : (
            <div className="away-sidebar-card">
              <div className="section-subtitle">Away Mode</div>
              <input
                className="task-input"
                placeholder="Goals (semicolon separated)"
                value={awayInput}
                onChange={(e) => setAwayInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && startAway()}
              />
              <button className="submit-btn accent" onClick={startAway} disabled={!awayInput.trim()}>
                Start Away
              </button>
            </div>
          )}
        </aside>

        {/* MAIN CONTENT */}
        <main className="main-content">
          {/* COST ALERT BANNER */}
          {costAlert && (
            <div className="cost-alert-banner">
              <span className="alert-text">Cost threshold exceeded! Total: ${queueStats.totalCost.toFixed(4)}</span>
              <button className="alert-dismiss-btn" onClick={() => setCostAlert(false)}>x</button>
            </div>
          )}

          {/* HERO STATS ROW */}
          <div className="hero-stats">
            <div className="stat-card">
              <div className="stat-label">Completed</div>
              <div className="stat-value">{queueStats.completed}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Running / Queue</div>
              <div className="stat-value" style={queueStats.running > 0 ? { background: 'linear-gradient(135deg, #3388ff, rgba(51,136,255,0.6))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' } : undefined}>
                {queueStats.running}/{queueStats.pending}
              </div>
            </div>
            <div className="stat-card gold-accent">
              <div className="stat-label">Total Cost</div>
              <div className="stat-value">${stats.totalCost.toFixed(4)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Uptime</div>
              <div className="stat-value">{formatUptime(stats.uptime)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Events</div>
              <div className="stat-value">{stats.totalEvents}</div>
            </div>
            <div className="queue-control">
              <button
                className={`queue-btn ${queueStats.paused ? 'paused' : 'running'}`}
                onClick={toggleQueuePause}
              >
                {queueStats.paused ? 'Resume' : 'Pause'}
              </button>
              {queueStats.failed > 0 && <span className="failed-label">{queueStats.failed} failed</span>}
            </div>
          </div>

          {/* TASK INPUT */}
          <div className="task-input-section glass-card">
            <h3 className="section-subtitle">New Task</h3>
            <div className="input-row">
              <input
                ref={inputRef}
                className="task-input"
                placeholder="Enter a task for the agents... (Enter to submit)"
                value={taskInput}
                onChange={(e) => setTaskInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitTask()}
                disabled={taskLoading}
              />
              <button className="submit-btn" onClick={submitTask} disabled={taskLoading || !taskInput.trim()}>
                {taskLoading ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>

          {/* TABS: Events / Tasks / Approvals */}
          <div className="glass-card tab-panel">
            <div className="tab-bar">
              <button
                className={`tab-button ${activeTab === 'events' ? 'active' : ''}`}
                onClick={() => setActiveTab('events')}
              >
                Events
              </button>
              <button
                className={`tab-button ${activeTab === 'tasks' ? 'active' : ''}`}
                onClick={() => setActiveTab('tasks')}
              >
                Tasks
              </button>
              <button
                className={`tab-button ${activeTab === 'approvals' ? 'active' : ''}`}
                onClick={() => setActiveTab('approvals')}
              >
                Approvals
                {pendingApprovals > 0 && (
                  <span className="approval-badge">{pendingApprovals}</span>
                )}
              </button>
            </div>

            <div className="tab-content scrollable">
              {activeTab === 'approvals' ? (
                <div className="event-list">
                  {approvals.length === 0 ? (
                    <div className="empty-state">No pending approvals</div>
                  ) : (
                    approvals.map((a) => (
                      <div key={a.id} className="event-item">
                        <span
                          className="event-type"
                          style={{
                            background: a.actionClass === 'RED' ? 'rgba(255,23,68,0.15)' : a.actionClass === 'YELLOW' ? 'rgba(255,171,0,0.15)' : 'rgba(57,255,20,0.15)',
                            color: a.actionClass === 'RED' ? 'var(--status-error)' : a.actionClass === 'YELLOW' ? 'var(--gold)' : 'var(--status-success)',
                          }}
                        >
                          {a.actionClass}
                        </span>
                        <span className="event-type agent-badge">{a.proposedBy}</span>
                        <span className="event-time">{formatTime(a.createdAt)}</span>
                        {a.status === 'pending' && (
                          <span style={{ display: 'inline-flex', gap: 4, marginLeft: 8 }}>
                            <button
                              className="btn-micro approve"
                              onClick={async () => {
                                await fetch(`${RUNTIME_URL}/api/approvals/${a.id}/approve`, { method: 'POST' });
                                const r = await fetch(`${RUNTIME_URL}/api/approvals`);
                                if (r.ok) setApprovals(await r.json());
                              }}
                            >
                              Approve
                            </button>
                            <button
                              className="btn-micro reject"
                              onClick={async () => {
                                await fetch(`${RUNTIME_URL}/api/approvals/${a.id}/reject`, { method: 'POST' });
                                const r = await fetch(`${RUNTIME_URL}/api/approvals`);
                                if (r.ok) setApprovals(await r.json());
                              }}
                            >
                              Reject
                            </button>
                          </span>
                        )}
                        {a.status !== 'pending' && (
                          <span style={{ marginLeft: 8, fontSize: 11, color: a.status === 'approved' ? 'var(--status-success)' : 'var(--status-error)' }}>
                            {a.status}
                          </span>
                        )}
                        <div style={{ marginTop: 4, color: 'var(--text-dim)', fontSize: 12, width: '100%' }}>
                          {a.description.slice(0, 120)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : activeTab === 'events' ? (
                <div className="event-list">
                  {events.length === 0 ? (
                    <div className="empty-state">Waiting for events...</div>
                  ) : (
                    events.map((event, i) => (
                      <div key={i} className="event-item">
                        <span className={`event-type ${event.type}`}>{event.type}</span>
                        <span className="event-time">{formatTime(event.timestamp)}</span>
                        {typeof event.data.goal === 'string' && (
                          <div style={{ marginTop: 4, color: 'var(--text-dim)', fontSize: 12, width: '100%' }}>
                            {(event.data.goal as string).slice(0, 100)}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="event-list">
                  {taskHistory.length === 0 ? (
                    <div className="empty-state">No tasks yet...</div>
                  ) : (
                    taskHistory.map((t) => (
                      <div key={t.id} className="event-item clickable" onClick={() => fetchTaskDetail(t.id)}>
                        <span className={`event-type ${t.status === 'done' ? 'task_completed' : t.status === 'failed' ? 'task_failed' : 'task_started'}`}>
                          {t.status}
                        </span>
                        {t.assignedTo && (
                          <span className="event-type agent-badge">{t.assignedTo}</span>
                        )}
                        {t.result?.confidence != null && (
                          <span style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                            {Math.round(t.result.confidence * 100)}%
                          </span>
                        )}
                        <span className="event-time">{formatTime(t.createdAt)}</span>
                        {t.status === 'failed' && (
                          <button
                            className="btn-micro retry"
                            onClick={(e) => { e.stopPropagation(); retryTask(t.id); }}
                          >
                            Retry
                          </button>
                        )}
                        <div style={{ marginTop: 4, color: 'var(--text-dim)', fontSize: 12, width: '100%' }}>
                          {(t.goal ?? '').slice(0, 100)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* LEARNING PANEL */}
          {Object.keys(learningData).length > 0 && (
            <div className="glass-card learning-section">
              <h3 className="section-subtitle">Agent Learning</h3>
              <div className="learning-grid">
                {Object.entries(learningData).map(([agent, data]) => {
                  const meta = AGENT_META[agent] || { emoji: '\uD83E\uDD16', color: 'var(--cyan)', role: 'Agent' };
                  return (
                    <div key={agent} className="learning-card">
                      <div className="learning-agent-name">
                        <span style={{ color: meta.color, marginRight: 6 }}>{meta.emoji}</span>
                        {agent}
                      </div>
                      <div className="learning-stats">
                        <span className="learning-stat">{data.tasks} tasks</span>
                        <span className="learning-stat" style={{ color: data.successRate >= 0.8 ? 'var(--status-success)' : data.successRate >= 0.5 ? 'var(--gold)' : 'var(--status-error)' }}>
                          {Math.round(data.successRate * 100)}%
                        </span>
                        <span className="learning-stat">conf: {data.avgConfidence.toFixed(2)}</span>
                        <span className="learning-stat gold-accent">${data.avgCost.toFixed(4)}/task</span>
                      </div>
                      {data.topCategories.length > 0 && (
                        <div className="learning-categories">
                          {data.topCategories.map((cat) => (
                            <span key={cat} className="category-tag">{cat}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* TASK DETAIL MODAL */}
      {selectedTask && (
        <div className="modal-overlay" onClick={() => setSelectedTask(null)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Task Detail</h2>
              <button className="modal-close-btn" onClick={() => setSelectedTask(null)}>x</button>
            </div>
            <div className="modal-body">
              <div className="detail-row">
                <span className="detail-label">Goal</span>
                <span className="detail-value">{selectedTask.goal}</span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Status</span>
                <span className={`event-type ${selectedTask.status === 'done' ? 'task_completed' : selectedTask.status === 'failed' ? 'task_failed' : 'task_started'}`}>
                  {selectedTask.status}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-label">Agent</span>
                <span className="detail-value">
                  {selectedTask.assignedTo ? (
                    <>
                      <span style={{ marginRight: 6 }}>{AGENT_META[selectedTask.assignedTo]?.emoji}</span>
                      {selectedTask.assignedTo}
                    </>
                  ) : '-'}
                </span>
              </div>
              {selectedTask.result && (
                <>
                  <div className="detail-row">
                    <span className="detail-label">Confidence</span>
                    <span className="detail-value">{(selectedTask.result.confidence ?? 0).toFixed(2)}</span>
                  </div>
                  <div className="detail-row">
                    <span className="detail-label">Cost</span>
                    <span className="detail-value gold-accent">${(selectedTask.result.costUsd ?? 0).toFixed(6)}</span>
                  </div>
                  {selectedTask.result.reasoning && (
                    <div className="detail-section">
                      <span className="detail-label">Reasoning</span>
                      <pre className="detail-pre">{selectedTask.result.reasoning}</pre>
                    </div>
                  )}
                  {selectedTask.result.output && (
                    <div className="detail-section">
                      <span className="detail-label">Output</span>
                      <pre className="detail-pre">{typeof selectedTask.result.output === 'string' ? selectedTask.result.output : JSON.stringify(selectedTask.result.output, null, 2)}</pre>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
