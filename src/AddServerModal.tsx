import React, { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Plus } from 'lucide-react';
import * as api from './api';
import { useApp } from './AppContext';
import type { ServerInfo } from './types';

export function AddServerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setError, setNotice, refreshServers, selectServer } = useApp();
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('paper');
  const [newVersion, setNewVersion] = useState('');
  const [ramGb, setRamGb] = useState(2);
  const [versions, setVersions] = useState<string[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dlBytes, setDlBytes] = useState(0);

  const loadVersions = useCallback(async (kind: string) => {
    if (!api.isTauri()) return;
    setVersionsLoading(true);
    setVersions([]);
    setNewVersion('');
    try {
      const list = await api.listVersions(kind);
      setVersions(list);
      setNewVersion(list[0] ?? '');
    } catch {
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      setNotice(null);
      setDlBytes(0);
      loadVersions(newKind);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  async function createAndDownload() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    setDlBytes(0);
    try {
      const off = await listen<{ id: string; bytes: number }>('download-progress', (event) =>
        setDlBytes(event.payload.bytes),
      ).catch(() => null);
      const created = await api.createServer(name, newKind, newVersion, Number(ramGb) || 2);
      const msg = await api.downloadServer(created.id, newKind, newVersion);
      if (off) off();
      setNewName('');
      setNotice(`${created.name}: ${msg}`);
      await refreshServers();
      selectServer(created.id);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <div className="modal">
        <h2>Add a server</h2>
        <label>
          Name
          <input
            value={newName}
            placeholder="my-minecraft-server"
            onChange={(event) => setNewName(event.target.value)}
            disabled={creating}
          />
        </label>
        <div className="form-grid">
          <label>
            Server type
            <select
              value={newKind}
              disabled={creating}
              onChange={(event) => {
                const kind = event.target.value;
                setNewKind(kind);
                loadVersions(kind);
              }}
            >
              <option value="paper">Paper</option>
              <option value="vanilla">Vanilla</option>
              <option value="bungeecord">BungeeCord</option>
            </select>
          </label>
          <label>
            Version
            <select
              value={newVersion}
              disabled={versionsLoading || creating || newKind === 'paper' || newKind === 'bungeecord'}
              onChange={(event) => setNewVersion(event.target.value)}
            >
              {newKind === 'paper' && <option value="latest">Latest stable (auto)</option>}
              {newKind === 'bungeecord' && <option value="latest">Latest</option>}
              {newKind === 'vanilla' &&
                (versionsLoading ? (
                  <option value="">Loading versions…</option>
                ) : (
                  versions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))
                ))}
            </select>
          </label>
          <label>
            RAM (GB)
            <input
              type="number"
              min={1}
              max={32}
              value={ramGb}
              disabled={creating}
              onChange={(event) => setRamGb(Number(event.target.value))}
            />
          </label>
        </div>
        <p className="toolbar-hint">The server jar is downloaded automatically from the official source — no manual setup.</p>
        {creating && dlBytes > 0 && <div className="dl-progress">Downloading… {(dlBytes / 2 ** 20).toFixed(1)} MB</div>}
        <div className="modal-actions">
          <button disabled={creating} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={creating || !newName.trim()} onClick={createAndDownload}>
            {creating ? 'Creating & downloading…' : 'Create & download'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddServerButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="add-server" onClick={onOpen}>
      <Plus size={24} /> Add server
    </button>
  );
}

export type { ServerInfo };
