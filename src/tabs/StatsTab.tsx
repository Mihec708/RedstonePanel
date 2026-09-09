import React from 'react';
import { Activity, Clock, Cpu, MemoryStick } from 'lucide-react';
import { useApp } from '../AppContext';
import { Sparkline, formatUptime } from '../mcformat';
import { KIND_LABEL } from '../types';

export function StatsTab() {
  const { selected, stats, history } = useApp();

  if (!selected) {
    return <div className="tab-empty">Select or add a server to see its statistics.</div>;
  }

  const cpu = stats?.cpu ?? 0;
  const ramUsed = stats?.ram_used ?? 0;
  const ramAlloc = stats?.ram_alloc ?? selected.ram_gb * 2 ** 30;
  const ramPct = ramAlloc > 0 ? Math.min((ramUsed / ramAlloc) * 100, 100) : 0;
  const running = selected.running;

  return (
    <div className="tab-body">
      <section className="panel">
        <header>
          <h2>Server Statistics</h2>
          <span className="status-chip" data-state={running ? 'on' : 'off'}>
            {running ? 'ONLINE' : 'OFFLINE'}
          </span>
          <span className="toolbar-hint">
            {KIND_LABEL[selected.kind]} {selected.version}
          </span>
        </header>
        <p className="toolbar-hint">
          Live stats for <strong>{selected.name}</strong> only — not your whole PC. Updates every 3 seconds
          while the server is running.
        </p>
      </section>

      <div className="stats-grid">
        <article className="stat-card">
          <span className="stat-label">
            <Cpu size={15} /> CPU usage
          </span>
          <strong>{running ? `${cpu.toFixed(1)}%` : '—'}</strong>
          <Sparkline values={history.cpu} tone="red" />
        </article>
        <article className="stat-card">
          <span className="stat-label">
            <MemoryStick size={15} /> RAM (server)
          </span>
          <strong>
            {running
              ? `${(ramUsed / 2 ** 30).toFixed(1)} / ${(ramAlloc / 2 ** 30).toFixed(1)} GB`
              : `${(ramAlloc / 2 ** 30).toFixed(0)} GB allocated`}
          </strong>
          <div className="ram-bar" title={running ? `${ramPct.toFixed(0)}% of allocated RAM in use` : ''}>
            <div className="ram-bar-fill" style={{ width: `${running ? ramPct : 0}%` }} />
          </div>
        </article>
        <article className="stat-card">
          <span className="stat-label">
            <Clock size={15} /> Uptime
          </span>
          <strong>{running ? formatUptime(stats?.uptime_secs ?? 0) : '—'}</strong>
          <div className="stat-foot">{running ? 'Since last start' : 'Server is stopped'}</div>
        </article>
        <article className="stat-card">
          <span className="stat-label">
            <Activity size={15} /> RAM history
          </span>
          <strong>{running ? `${ramPct.toFixed(0)}% in use` : '—'}</strong>
          <Sparkline values={history.ram} tone="gold" />
        </article>
      </div>
    </div>
  );
}
