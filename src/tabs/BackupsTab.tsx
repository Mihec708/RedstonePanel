import React, { useCallback, useEffect, useState } from 'react';
import { Archive, Clock3, RotateCcw, Trash2 } from 'lucide-react';
import { useApp } from '../AppContext';
import * as api from '../api';
import type { BackupInfo, Schedule } from '../types';
import { formatBytes } from '../mcformat';

const ACTION_LABEL: Record<string, string> = {
  start: 'Start server',
  stop: 'Stop server',
  restart: 'Restart server',
  backup: 'Take backup',
  command: 'Run console command',
};

const REPEAT_LABEL: Record<string, string> = {
  none: 'One time',
  hourly: 'Every hour',
  daily: 'Every day',
  weekly: 'Every week',
};

function timeUntil(secs: number): string {
  if (secs <= 0) return 'due now';
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `in ${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `in ${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

export function BackupsTab() {
  const { selected, setError, setNotice, refreshServers } = useApp();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [working, setWorking] = useState(false);
  // scheduler form
  const [action, setAction] = useState('backup');
  const [delayMin, setDelayMin] = useState(60);
  const [repeat, setRepeat] = useState('daily');
  const [command, setCommand] = useState('');

  const refresh = useCallback(async () => {
    if (!selected) return;
    try {
      setBackups(await api.listBackups(selected.id));
    } catch {
      setBackups([]);
    }
    try {
      setSchedules(await api.listSchedules(selected.id));
    } catch {
      setSchedules([]);
    }
  }, [selected?.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!selected) {
    return <div className="tab-empty">Select or add a server to manage backups and schedules.</div>;
  }

  async function doBackup() {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.createBackup(selected!.id);
      setNotice(result);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }

  async function doRestore(backup: BackupInfo) {
    if (!window.confirm(`Restore from "${backup.name}"? This replaces the current server folder and the server must be stopped.`)) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.restoreBackup(selected!.id, backup.name);
      setNotice(result);
      await refresh();
      refreshServers().catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }

  async function doDeleteBackup(backup: BackupInfo) {
    if (!window.confirm(`Delete backup "${backup.name}"? This cannot be undone.`)) return;
    setWorking(true);
    setError(null);
    try {
      await api.deleteBackup(selected!.id, backup.name);
      setNotice(`Deleted ${backup.name}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }

  async function addSchedule() {
    setError(null);
    setNotice(null);
    try {
      const list = await api.addSchedule(
        selected!.id,
        action,
        Math.max(1, Number(delayMin) || 1) * 60,
        repeat,
        action === 'command' ? command.trim() || null : null,
      );
      setSchedules(list);
      setNotice('Schedule added');
      setCommand('');
    } catch (e) {
      setError(String(e));
    }
  }

  async function removeSchedule(schedule: Schedule) {
    try {
      setSchedules(await api.removeSchedule(selected!.id, schedule.sid));
    } catch (e) {
      setError(String(e));
    }
  }

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="tab-body backups-layout">
      <section className="panel">
        <header>
          <span className="panel-icon">
            <Archive />
          </span>
          <h2>Backups</h2>
          <span className="panel-actions">
            <button className="primary" onClick={doBackup} disabled={working}>
              <Archive size={14} /> {working ? 'Working…' : 'Create backup'}
            </button>
          </span>
        </header>
        <p className="toolbar-hint">
          Full snapshots of the server folder — restore one to roll back (server must be stopped).
        </p>
        <div className="backup-list">
          {backups.length === 0 && (
            <p className="toolbar-hint">No backups yet — create your first one.</p>
          )}
          {backups.map((backup) => (
            <div className="backup-row" key={backup.name}>
              <div className="backup-info">
                <strong>{backup.name}</strong>
                <small>
                  {formatBytes(backup.size)} · {new Date(backup.mtime).toLocaleString()}
                </small>
              </div>
              <span className="player-actions">
                <button onClick={() => doRestore(backup)} disabled={working || selected.running}>
                  <RotateCcw size={13} /> Restore
                </button>
                <button className="danger" onClick={() => doDeleteBackup(backup)} disabled={working}>
                  <Trash2 size={13} /> Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <header>
          <span className="panel-icon">
            <Clock3 />
          </span>
          <h2>Scheduler</h2>
        </header>
        <p className="toolbar-hint">
          Automate the server: start, stop, restart, backup, or run any console command on a schedule.
        </p>
        <div className="sched-form">
          <label>
            Action
            <select value={action} onChange={(event) => setAction(event.target.value)}>
              {Object.entries(ACTION_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Delay (minutes)
            <input
              type="number"
              min={1}
              value={delayMin}
              onChange={(event) => setDelayMin(Number(event.target.value))}
            />
          </label>
          <label>
            Repeat
            <select value={repeat} onChange={(event) => setRepeat(event.target.value)}>
              {Object.entries(REPEAT_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {action === 'command' && (
            <label>
              Command
              <input
                value={command}
                placeholder="say Good night, see you tomorrow"
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
          )}
          <button className="primary" onClick={addSchedule}>
            Add schedule
          </button>
        </div>
        <div className="sched-list">
          {schedules.length === 0 && <p className="toolbar-hint">No schedules yet.</p>}
          {schedules.map((schedule) => (
            <div className="sched-row" key={schedule.sid}>
              <div className="sched-info">
                <strong>{ACTION_LABEL[schedule.action] ?? schedule.action}</strong>
                <small>
                  {REPEAT_LABEL[schedule.repeat] ?? schedule.repeat} · next {timeUntil(schedule.next_run - now)}
                  {schedule.command ? ` · "${schedule.command}"` : ''}
                </small>
              </div>
              <button className="danger" onClick={() => removeSchedule(schedule)}>
                <Trash2 size={13} /> Remove
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
