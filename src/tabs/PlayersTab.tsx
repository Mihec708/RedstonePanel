import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Shield, Users } from 'lucide-react';
import { useApp } from '../AppContext';
import * as api from '../api';
import type { PlayerInfo } from '../types';
import { stripMcText } from '../mcformat';

function headUrl(player: { name: string; uuid: string }): string {
  const key = player.uuid || player.name;
  return `https://crafatar.com/avatars/${encodeURIComponent(key)}?size=64&overlay=false`;
}

function PlayerHead({ player }: { player: PlayerInfo }) {
  const [failed, setFailed] = useState(false);
  if (failed || !player.uuid) {
    return <span className="avatar">{(player.name || '?').slice(0, 1).toUpperCase()}</span>;
  }
  return (
    <img
      className="player-head"
      src={headUrl(player)}
      alt={`${player.name} skin head`}
      onError={() => setFailed(true)}
    />
  );
}

function PlayerRow({ player, online }: { player: PlayerInfo; online: boolean }) {
  const { selected, sendCommand, setNotice } = useApp();
  async function act(cmd: string, label: string) {
    if (!selected) return;
    await sendCommand(cmd);
    setNotice(`${label} sent to console: ${cmd}`);
  }
  return (
    <div className="player">
      <PlayerHead player={player} />
      <strong className="player-name">
        {player.name}
        {online && <span className="online-dot" title="Online" />}
      </strong>
      <span className="player-uuid" title={player.uuid}>
        {player.uuid.slice(0, 8)}…
      </span>
      <span className="player-actions">
        <button title="Make operator" onClick={() => act(`op ${player.name}`, 'OP')}>
          <Shield size={13} /> OP
        </button>
        <button title="Remove operator" onClick={() => act(`deop ${player.name}`, 'Deop')}>
          DeOP
        </button>
        <button title="Kick from server" onClick={() => act(`kick ${player.name}`, 'Kick')}>
          Kick
        </button>
        <button className="danger" title="Ban player" onClick={() => act(`ban ${player.name}`, 'Ban')}>
          Ban
        </button>
      </span>
    </div>
  );
}

export function PlayersTab() {
  const { selected, sendCommand, selectedLines, setError, setNotice } = useApp();
  const [past, setPast] = useState<PlayerInfo[]>([]);
  const [whitelist, setWhitelist] = useState<PlayerInfo[]>([]);
  const [wlName, setWlName] = useState('');
  const [wlEnabled, setWlEnabled] = useState(false);
  const [wlToggling, setWlToggling] = useState(false);

  const refreshLists = useCallback(async () => {
    if (!selected) return;
    try {
      setPast(await api.listPlayers(selected.id));
    } catch {
      setPast([]);
    }
    try {
      setWhitelist(await api.listWhitelist(selected.id));
    } catch {
      setWhitelist([]);
    }
    try {
      setWlEnabled(await api.whitelistStatus(selected.id));
    } catch {
      setWlEnabled(false);
    }
  }, [selected?.id]);

  useEffect(() => {
    refreshLists();
  }, [refreshLists]);

  // Parse the most recent `list` command output from the console.
  let online: PlayerInfo[] = [];
  if (selected) {
    for (let i = selectedLines.length - 1; i >= 0; i--) {
      const text = stripMcText(selectedLines[i].line).replace(/\n/g, ' ');
      const match = text.match(/There are (\d+) of a max of (\d+) players online:\s*(.*)/i);
      if (match) {
        const names = match[3]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        online = names.map((name) => ({ name, uuid: '' }));
        break;
      }
    }
  }

  if (!selected) {
    return <div className="tab-empty">Select or add a server to manage its players.</div>;
  }

  async function askOnlineList() {
    await sendCommand('list');
  }

  async function addWhitelist() {
    const name = wlName.trim();
    if (!name) return;
    await sendCommand(`whitelist add ${name}`);
    setWlName('');
    await refreshLists();
  }

  async function removeWhitelist(name: string) {
    await sendCommand(`whitelist remove ${name}`);
    await refreshLists();
  }

  return (
    <div className="tab-body players-layout">
      <section className="panel">
        <header>
          <h2>
            <Users size={16} className="inline-icon" /> Online players
          </h2>
          <span className="panel-actions">
            <button onClick={askOnlineList} disabled={!selected.running}>
              <RefreshCw size={14} /> Refresh
            </button>
          </span>
        </header>
        {!selected.running && <p className="toolbar-hint">Server is stopped — start it to see who's online.</p>}
        {selected.running && (
          <>
            {online.length === 0 ? (
              <p className="toolbar-hint">No one online right now (or press Refresh after the server is up).</p>
            ) : (
              online.map((p) => <PlayerRow key={p.name} player={p} online />)
            )}
          </>
        )}
      </section>

      <section className="panel">
        <header>
          <h2>Player history</h2>
          <span className="panel-actions">
            <button onClick={refreshLists}>
              <RefreshCw size={14} /> Refresh
            </button>
          </span>
        </header>
        <p className="toolbar-hint">Everyone who has joined this server (from the world data), with their skin head.</p>
        {past.length === 0 ? (
          <p className="toolbar-hint">No players have joined yet.</p>
        ) : (
          past.map((p) => <PlayerRow key={p.uuid || p.name} player={p} online={false} />)
        )}
      </section>

      <section className="panel">
        <header>
          <h2>Whitelist</h2>
          <span className="panel-actions">
            <button
              type="button"
              className={`ios-switch ${wlEnabled ? 'on' : ''}`}
              aria-pressed={wlEnabled}
              title={wlEnabled ? 'Whitelist is on — click to turn off' : 'Whitelist is off — click to turn on'}
              disabled={wlToggling}
              onClick={async () => {
                if (wlToggling || !selected) return;
                setWlToggling(true);
                setError(null);
                try {
                  const next = !wlEnabled;
                  const msg = await api.setWhitelist(selected.id, next);
                  setWlEnabled(next);
                  setNotice(`${msg} — restart the server to make it stick`);
                } catch (e) {
                  setError(String(e));
                } finally {
                  setWlToggling(false);
                }
              }}
            >
              <span className="ios-knob" />
            </button>
            <span className="switch-label">{wlEnabled ? 'On' : 'Off'}</span>
            <button onClick={refreshLists}>
              <RefreshCw size={14} /> Refresh
            </button>
          </span>
        </header>
        <p className="toolbar-hint">
          Flip the switch to only let whitelisted players in. Add players below (works while the
          server is running).
        </p>
        <div className="command-bar">
          <input
            value={wlName}
            placeholder="Player name to whitelist"
            onChange={(event) => setWlName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && addWhitelist()}
          />
          <button onClick={addWhitelist} disabled={!wlName.trim()}>
            Add
          </button>
        </div>
        <div className="whitelist-list">
          {whitelist.length === 0 ? (
            <p className="toolbar-hint">Whitelist is empty.</p>
          ) : (
            whitelist.map((p) => (
              <div className="player" key={p.uuid || p.name}>
                <PlayerHead player={p} />
                <strong className="player-name">{p.name}</strong>
                <span className="player-actions">
                  <button className="danger" onClick={() => removeWhitelist(p.name)}>
                    Remove
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
