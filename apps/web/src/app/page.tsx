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

interface McpToolStat { calls: number; errors: number; totalMs: number; lastMs: number }
interface McpInfo {
  enabled: boolean;
  servers: { name: string; transport: string; tools: number }[];
  stats: { totalCalls: number; totalErrors: number; byTool: Record<string, McpToolStat> };
}

const RUNTIME_URL = process.env.NEXT_PUBLIC_RUNTIME_URL || 'http://localhost:3000';
const API_KEY = process.env.NEXT_PUBLIC_UAI_API_KEY || '';

/** Runtime fetch with X-Api-Key when configured (runtime may require auth). */
function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = RUNTIME_URL + path;
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (API_KEY) headers['X-Api-Key'] = API_KEY;
  return fetch(url, { ...init, headers });
}

const AGENT_META: Record<string, { emoji: string; role: string }> = {
  core: { emoji: '⚙️', role: 'Orchestrator' },
  brain: { emoji: '🧠', role: 'Reasoning' },
  arch: { emoji: '🏗️', role: 'Architecture' },
  front: { emoji: '🎨', role: 'Frontend' },
  ops: { emoji: '⚡', role: 'Operations' },
  qa: { emoji: '✓', role: 'Quality' },
};

function getStatusClass(status: string): string {
  if (status === 'working' || status === 'thinking' || status === 'running') return 'working';
  if (status === 'error' || status === 'failed') return 'error';
  return 'idle';
}

function evClass(type: string): 'ok' | 'work' | 'err' | 'info' {
  if (type.includes('completed')) return 'ok';
  if (type.includes('failed') || type.includes('error')) return 'err';
  if (type.includes('started') || type.includes('status')) return 'work';
  return 'info';
}

function taskClass(status: string): 'ok' | 'err' | 'work' {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'err';
  return 'work';
}

/** Build a throughput sparkline from consecutive-sample deltas. */
function Sparkline({ totals }: { totals: number[] }) {
  const w = 120, h = 26;
  if (totals.length < 3) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />;
  const values = totals.slice(1).map((v, i) => Math.max(0, v - totals[i]));
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 3 - (v / max) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="spark-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(47,211,238,0.28)" />
          <stop offset="1" stopColor="rgba(47,211,238,0)" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-g)" />
      <path d={line} fill="none" stroke="var(--cyan)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={lx} cy={ly} r="2.4" fill="var(--cyan)" />
    </svg>
  );
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
  const [stats, setStats] = useState({ tasksCompleted: 0, totalCost: 0, totalEvents: 0, uptime: 0 });
  const [queueStats, setQueueStats] = useState({ pending: 0, running: 0, completed: 0, failed: 0, avgDurationMs: 0, paused: false, totalCost: 0 });
  const [costAlert, setCostAlert] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [spark, setSpark] = useState<number[]>([]);

  const [taskInput, setTaskInput] = useState('');
  const [taskLoading, setTaskLoading] = useState(false);
  const [awayInput, setAwayInput] = useState('');
  const [awayStatus, setAwayStatus] = useState<AwayStatus>({ active: false });
  const [taskHistory, setTaskHistory] = useState<TaskRow[]>([]);
  const [activeTab, setActiveTab] = useState<'events' | 'tasks' | 'approvals'>('events');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [selectedTask, setSelectedTask] = useState<(TaskRow & { result?: { output?: string; confidence?: number; reasoning?: string; costUsd?: number } }) | null>(null);
  const [learningData, setLearningData] = useState<LearningData>({});
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const eventCountRef = useRef(0);

  useEffect(() => {
    const es = new EventSource(`${RUNTIME_URL}/api/stream${API_KEY ? `?key=${encodeURIComponent(API_KEY)}` : ''}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as DashboardEvent;
        eventCountRef.current += 1;
        setEvents((prev) => [event, ...prev].slice(0, 100));
        setStats((prev) => ({ ...prev, totalEvents: prev.totalEvents + 1 }));

        if (event.type === 'agent_status') {
          const name = event.data.agent as string;
          const status = event.data.status as string;
          if (name) setAgents((prev) => prev.map((a) => (a.name === name ? { ...a, status } : a)));
        }
        if (event.type === 'task_completed') {
          const cost = (event.data.cost as number) || 0;
          setStats((prev) => ({ ...prev, tasksCompleted: prev.tasksCompleted + 1, totalCost: prev.totalCost + cost }));
          fetchTasks();
        }
        if (event.type === 'cost_alert') setCostAlert(true);
      } catch {
        // ignore
      }
    };

    const pollInterval = setInterval(async () => {
      try {
        const [healthRes, awayRes, agentsRes, queueRes, learnRes, approvalsRes, mcpRes] = await Promise.all([
          apiFetch(`/health`),
          apiFetch(`/api/away/status`),
          apiFetch(`/api/agents`),
          apiFetch(`/api/queue`),
          apiFetch(`/api/learning`),
          apiFetch(`/api/approvals`),
          apiFetch(`/api/mcp`),
        ]);
        setConnected(true);
        setAuthError([agentsRes, queueRes, learnRes].some((r) => r.status === 401));
        setSpark((prev) => [...prev, eventCountRef.current].slice(-25));

        // Yalnızca yetkili (2xx) yanıtları kullan — 401 gövdesini render etme
        if (healthRes.ok) { const h = await healthRes.json(); setStats((prev) => ({ ...prev, uptime: Math.round(h?.uptime ?? 0) })); }
        if (awayRes.ok) setAwayStatus((await awayRes.json()) ?? { active: false });
        if (agentsRes.ok) {
          const agentData = await agentsRes.json();
          setAgents((prev) => prev.map((a) => {
            const server = agentData?.[a.name];
            return server ? { ...a, status: server.status, cost: server.cost } : a;
          }));
        }
        if (queueRes.ok) { const q = await queueRes.json(); setQueueStats((prev) => ({ ...prev, ...q })); }
        if (learnRes.ok) setLearningData((await learnRes.json()) ?? {});
        if (approvalsRes.ok) setApprovals(await approvalsRes.json());
        if (mcpRes.ok) setMcpInfo(await mcpRes.json());
      } catch {
        setConnected(false);
      }
    }, 5_000);

    fetchTasks();
    return () => { es.close(); clearInterval(pollInterval); };
  }, []);

  async function fetchTasks() {
    try {
      const res = await apiFetch(`/api/tasks?limit=15`);
      setTaskHistory(await res.json());
    } catch { /* ignore */ }
  }
  async function fetchTaskDetail(id: string) {
    try {
      const res = await apiFetch(`/api/tasks/${id}`);
      setSelectedTask(await res.json());
    } catch { /* ignore */ }
  }
  async function submitTask() {
    if (!taskInput.trim() || taskLoading) return;
    setTaskLoading(true);
    try {
      await apiFetch(`/api/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: taskInput }) });
      setTaskInput('');
      inputRef.current?.focus();
    } catch { /* ignore */ } finally { setTaskLoading(false); }
  }
  async function startAway() {
    const goals = awayInput.split(';').map((g) => g.trim()).filter(Boolean);
    if (!goals.length) return;
    try {
      await apiFetch(`/api/away/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goals }) });
      setAwayInput('');
    } catch { /* ignore */ }
  }
  async function stopAway() {
    try { await apiFetch(`/api/away/stop`, { method: 'POST' }); } catch { /* ignore */ }
  }
  async function toggleQueuePause() {
    try { await apiFetch(`/api/queue/${queueStats.paused ? 'resume' : 'pause'}`, { method: 'POST' }); } catch { /* ignore */ }
  }
  async function retryTask(taskId: string) {
    try {
      await apiFetch(`/api/task/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }) });
      fetchTasks();
    } catch { /* ignore */ }
  }
  async function resolveApproval(id: string, ok: boolean) {
    try {
      await apiFetch(`/api/approvals/${id}/${ok ? 'approve' : 'reject'}`, { method: 'POST' });
      const r = await apiFetch(`/api/approvals`);
      if (r.ok) setApprovals(await r.json());
    } catch { /* ignore */ }
  }

  const formatTime = (ts: string) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const formatUptime = (s: number) => { const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };

  const pendingApprovals = approvals.filter((a) => a.status === 'pending').length;
  const topTools = mcpInfo ? Object.entries(mcpInfo.stats.byTool).sort((a, b) => b[1].calls - a[1].calls).slice(0, 4) : [];
  const maxToolCalls = topTools.length ? topTools[0][1].calls : 1;

  return (
    <>
      {/* ═══ TOPBAR ═══ */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">U</div>
          <span className="brand-name">UAI&nbsp;Agents</span>
          <span className="chip">v1.0</span>
        </div>
        <span className="top-sub hide-sm">6 agents · real-time orchestration</span>
        <div className="top-right">
          {awayStatus.active && <span className="pill warn hide-sm"><span className="dot" />Away</span>}
          <button className={`pill btn hide-sm ${queueStats.paused ? 'warn' : ''}`} onClick={toggleQueuePause}>
            {queueStats.paused ? '▶ Resume queue' : '⏸ Pause queue'}
          </button>
          <span className={`pill ${connected ? 'live' : 'off'}`}><span className="dot" />{connected ? 'Live' : 'Offline'}</span>
        </div>
      </header>

      <div className="shell">
        {/* ═══ SIDEBAR ═══ */}
        <aside className="sidebar">
          <div className="side-head">
            <span className="eyebrow">Agents</span>
            <span className="side-count num">{agents.length}</span>
          </div>

          {agents.map((agent) => {
            const meta = AGENT_META[agent.name] || { emoji: '🤖', role: 'Agent' };
            const sc = getStatusClass(agent.status);
            return (
              <div key={agent.name} className={`agent ${sc === 'working' ? 'working' : ''}`}>
                <span className="agent-emoji">{meta.emoji}</span>
                <div>
                  <div className="agent-name">{agent.name}</div>
                  <div className="agent-role">{meta.role}</div>
                </div>
                <div className="agent-right">
                  <span className={`sdot ${sc}`} title={agent.status} />
                  <span className="agent-cost">${(agent.cost ?? 0).toFixed(4)}</span>
                </div>
              </div>
            );
          })}

          <div className="side-divider" />

          {awayStatus.active ? (
            <div className="away">
              <span className="eyebrow">Away mode · running</span>
              <div className="away-row">
                <div className="away-stat"><div className="away-val num">{awayStatus.elapsedMinutes ?? 0}m</div><div className="away-lbl">Time</div></div>
                <div className="away-stat"><div className="away-val num">{awayStatus.tasksCompleted ?? 0}</div><div className="away-lbl">Done</div></div>
                <div className="away-stat"><div className="away-val num gold">${(awayStatus.totalCost ?? 0).toFixed(2)}</div><div className="away-lbl">Cost</div></div>
              </div>
              <button className="btn-micro reject" onClick={stopAway}>Stop away mode</button>
            </div>
          ) : (
            <div className="away">
              <span className="eyebrow">Away mode</span>
              <input className="cmd" style={{ padding: '9px 12px', fontSize: 13 }} placeholder="Goals (semicolon separated)" value={awayInput} onChange={(e) => setAwayInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && startAway()} />
              <button className="btn-primary" style={{ justifyContent: 'center' }} onClick={startAway} disabled={!awayInput.trim()}>Start away mode</button>
            </div>
          )}
        </aside>

        {/* ═══ MAIN ═══ */}
        <main className="main">
          {costAlert && (
            <div className="cost-alert">
              <span>Cost threshold exceeded — total ${(queueStats.totalCost ?? 0).toFixed(4)}</span>
              <button onClick={() => setCostAlert(false)} aria-label="Dismiss">×</button>
            </div>
          )}
          {authError && (
            <div className="cost-alert" style={{ color: 'var(--warn)', background: 'rgba(242,179,74,0.1)', borderColor: 'rgba(242,179,74,0.3)' }}>
              <span>Runtime yetki istiyor (401). <span className="num">NEXT_PUBLIC_UAI_API_KEY</span> değerini runtime&apos;ın <span className="num">UAI_API_KEY</span>&apos;i ile eşleştirip web sunucusunu yeniden başlat.</span>
            </div>
          )}

          {/* stat strip */}
          <section className="stat-strip">
            <div className="stat">
              <div className="eyebrow">Completed</div>
              <div className="stat-num">{queueStats.completed}</div>
              <div className="stat-delta">{queueStats.failed > 0 ? <><span className="down">{queueStats.failed} failed</span></> : <span className="flat">all clear</span>}</div>
            </div>
            <div className="stat">
              <div className="eyebrow">Running / Queue</div>
              <div className="stat-num">{queueStats.running}<span className="sep">/</span>{queueStats.pending}</div>
              <div className="stat-delta"><span className="flat">avg {((queueStats.avgDurationMs ?? 0) / 1000).toFixed(1)}s</span></div>
            </div>
            <div className="stat">
              <div className="eyebrow">Total cost</div>
              <div className="stat-num gold">${(stats.totalCost ?? 0).toFixed(4)}</div>
              <div className="stat-delta"><span className="flat">queue ${(queueStats.totalCost ?? 0).toFixed(4)}</span></div>
            </div>
            <div className="stat">
              <div className="eyebrow">Uptime</div>
              <div className="stat-num">{formatUptime(stats.uptime)}</div>
              <div className="stat-delta"><span className={connected ? 'up' : 'down'}>{connected ? 'db · redis ok' : 'disconnected'}</span></div>
            </div>
            <div className="stat">
              <div className="eyebrow">Events</div>
              <div className="stat-num">{stats.totalEvents.toLocaleString()}</div>
              <Sparkline totals={spark} />
            </div>
          </section>

          {/* command bar */}
          <section className="cmd">
            <svg className="search-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input ref={inputRef} placeholder="Send a task to the agents…  (Enter to submit)" value={taskInput} onChange={(e) => setTaskInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submitTask()} disabled={taskLoading} aria-label="Send a task" />
            <button className="btn-primary" onClick={submitTask} disabled={taskLoading || !taskInput.trim()}>
              {taskLoading ? 'Sending…' : 'Send'}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
            </button>
          </section>

          {/* content */}
          <section className="content">
            {/* activity panel */}
            <div className="panel">
              <div className="panel-head">
                <span className="panel-title">Activity</span>
                <div className="seg">
                  <button className={activeTab === 'events' ? 'on' : ''} onClick={() => setActiveTab('events')}>Events</button>
                  <button className={activeTab === 'tasks' ? 'on' : ''} onClick={() => setActiveTab('tasks')}>Tasks</button>
                  <button className={activeTab === 'approvals' ? 'on' : ''} onClick={() => setActiveTab('approvals')}>
                    Approvals{pendingApprovals > 0 && <span className="count">{pendingApprovals}</span>}
                  </button>
                </div>
              </div>

              <div className="feed">
                {activeTab === 'events' && (
                  events.length === 0 ? <div className="empty">Waiting for events…</div> :
                  events.map((event, i) => (
                    <div key={i} className={`ev ${evClass(event.type)}`}>
                      <span className={`tag ${evClass(event.type)}`}>{event.type}</span>
                      <div className="ev-body">
                        {typeof event.data.goal === 'string' && <div className="ev-msg">{(event.data.goal as string).slice(0, 120)}</div>}
                        {typeof event.data.agent === 'string' && <div className="ev-meta">{event.data.agent as string}{typeof event.data.status === 'string' ? ` → ${event.data.status}` : ''}</div>}
                      </div>
                      <span className="ev-time">{formatTime(event.timestamp)}</span>
                    </div>
                  ))
                )}

                {activeTab === 'tasks' && (
                  taskHistory.length === 0 ? <div className="empty">No tasks yet</div> :
                  taskHistory.map((t) => (
                    <div key={t.id} className={`ev clickable ${taskClass(t.status)}`} onClick={() => fetchTaskDetail(t.id)}>
                      <span className={`tag ${taskClass(t.status)}`}>{t.status}</span>
                      <div className="ev-body">
                        <div className="ev-msg">{(t.goal ?? '').slice(0, 120)}</div>
                        <div className="ev-meta">
                          {t.assignedTo ? `${AGENT_META[t.assignedTo]?.emoji ?? ''} ${t.assignedTo}` : '—'}
                          {t.result?.confidence != null && ` · conf ${Math.round(t.result.confidence * 100)}%`}
                        </div>
                      </div>
                      <span className="ev-actions">
                        {t.status === 'failed' && <button className="btn-micro retry" onClick={(e) => { e.stopPropagation(); retryTask(t.id); }}>Retry</button>}
                        <span className="ev-time">{formatTime(t.createdAt)}</span>
                      </span>
                    </div>
                  ))
                )}

                {activeTab === 'approvals' && (
                  approvals.length === 0 ? <div className="empty">No pending approvals</div> :
                  approvals.map((a) => {
                    const cls = a.actionClass === 'RED' ? 'err' : a.actionClass === 'YELLOW' ? 'gold' : 'ok';
                    return (
                      <div key={a.id} className={`ev ${cls === 'gold' ? 'info' : cls}`}>
                        <span className={`tag ${cls}`}>{a.actionClass}</span>
                        <div className="ev-body">
                          <div className="ev-msg">{a.description.slice(0, 140)}</div>
                          <div className="ev-meta">{a.proposedBy} · {a.status}</div>
                        </div>
                        <span className="ev-actions">
                          {a.status === 'pending' ? (
                            <>
                              <button className="btn-micro approve" onClick={() => resolveApproval(a.id, true)}>Approve</button>
                              <button className="btn-micro reject" onClick={() => resolveApproval(a.id, false)}>Reject</button>
                            </>
                          ) : <span className="ev-time">{formatTime(a.createdAt)}</span>}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* right rail */}
            <div className="rail">
              {/* learning */}
              {Object.keys(learningData).length > 0 && (
                <div className="panel">
                  <div className="card-head"><span className="panel-title">Agent learning</span><span className="eyebrow">success</span></div>
                  <div className="card-body">
                    {Object.entries(learningData).map(([agent, data]) => {
                      const meta = AGENT_META[agent] || { emoji: '🤖', role: 'Agent' };
                      const sr = data?.successRate ?? 0;
                      const pct = Math.round(sr * 100);
                      const barColor = sr >= 0.8 ? 'var(--ok)' : sr >= 0.5 ? 'var(--warn)' : 'var(--err)';
                      return (
                        <div key={agent} className="learn">
                          <span className="learn-emoji">{meta.emoji}</span>
                          <div className="learn-meta">
                            <div className="learn-name">{agent}</div>
                            <div className="learn-sub">{data?.tasks ?? 0} tasks · ${(data?.avgCost ?? 0).toFixed(3)}/t</div>
                          </div>
                          <div className="bar"><span style={{ width: `${pct}%`, background: barColor }} /></div>
                          <span className="learn-pct">{pct}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* MCP */}
              <div className="panel">
                <div className="card-head">
                  <span className="panel-title">MCP</span>
                  {mcpInfo?.enabled
                    ? <span className="pill live"><span className="dot" />{mcpInfo.servers.length} connected</span>
                    : <span className="pill"><span className="dot" />off</span>}
                </div>
                <div className="card-body">
                  {!mcpInfo?.enabled ? (
                    <div className="empty" style={{ padding: '24px 8px' }}>No MCP servers connected.<br />Set <span className="num">MCP_SERVERS</span> to bridge external tools.</div>
                  ) : (
                    <>
                      <div className="mcp-servers">
                        {mcpInfo.servers.map((s) => (
                          <div key={s.name} className="mcp-srv">
                            <span className="sdot ok" />
                            <div><div className="name">{s.name}</div><div className="transport">{s.transport}</div></div>
                            <span className="tools">{s.tools} tools</span>
                          </div>
                        ))}
                      </div>
                      <div className="mcp-metrics">
                        <div className="mcp-metric"><div className="eyebrow">Tool calls</div><div className="v">{mcpInfo.stats.totalCalls}</div></div>
                        <div className="mcp-metric"><div className="eyebrow">Errors</div><div className="v" style={{ color: mcpInfo.stats.totalErrors > 0 ? 'var(--err)' : 'var(--ok)' }}>{mcpInfo.stats.totalErrors}</div></div>
                      </div>
                      {topTools.length > 0 && (
                        <div className="mcp-tool-list">
                          {topTools.map(([name, st]) => (
                            <div key={name} className="mcp-tool">
                              <span className="tname" title={name}>{name}</span>
                              <div className="tbar"><span style={{ width: `${Math.max(6, (st.calls / maxToolCalls) * 100)}%` }} /></div>
                              <span className="tn">{st.calls}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>

      {/* ═══ TASK DETAIL MODAL ═══ */}
      {selectedTask && (
        <div className="modal-overlay" onClick={() => setSelectedTask(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Task detail</h2>
              <button className="close" onClick={() => setSelectedTask(null)} aria-label="Close">×</button>
            </div>
            <div className="modal-body">
              <div className="detail-row"><span className="detail-label">Goal</span><span className="detail-value">{selectedTask.goal}</span></div>
              <div className="detail-row"><span className="detail-label">Status</span><span className={`tag ${taskClass(selectedTask.status)}`} style={{ justifySelf: 'start' }}>{selectedTask.status}</span></div>
              <div className="detail-row"><span className="detail-label">Agent</span><span className="detail-value">{selectedTask.assignedTo ? `${AGENT_META[selectedTask.assignedTo]?.emoji ?? ''} ${selectedTask.assignedTo}` : '—'}</span></div>
              {selectedTask.result && (
                <>
                  <div className="detail-row"><span className="detail-label">Confidence</span><span className="detail-value num">{(selectedTask.result.confidence ?? 0).toFixed(2)}</span></div>
                  <div className="detail-row"><span className="detail-label">Cost</span><span className="detail-value num gold">${(selectedTask.result.costUsd ?? 0).toFixed(6)}</span></div>
                  {selectedTask.result.reasoning && (
                    <div className="detail-section"><span className="detail-label">Reasoning</span><pre className="detail-pre">{selectedTask.result.reasoning}</pre></div>
                  )}
                  {selectedTask.result.output && (
                    <div className="detail-section"><span className="detail-label">Output</span><pre className="detail-pre">{typeof selectedTask.result.output === 'string' ? selectedTask.result.output : JSON.stringify(selectedTask.result.output, null, 2)}</pre></div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
