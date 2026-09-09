import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Archive,
  FileText,
  Puzzle,
  Server,
  SlidersHorizontal,
  SquareTerminal,
  Users,
  Zap,
} from 'lucide-react';
import './styles.css';
import { AppProvider, useApp } from './AppContext';
import { AddServerButton, AddServerModal } from './AddServerModal';
import { MainTab } from './tabs/MainTab';
import { FilesTab } from './tabs/FilesTab';
import { PluginsTab } from './tabs/PluginsTab';
import { StatsTab } from './tabs/StatsTab';
import { PropertiesTab } from './tabs/PropertiesTab';
import { PlayersTab } from './tabs/PlayersTab';
import { BackupsTab } from './tabs/BackupsTab';
import { renderMcText, stripMcText } from './mcformat';
import type { Tab } from './types';
import { KIND_LABEL } from './types';

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: 'main', label: 'Main', icon: <SquareTerminal size={15} /> },
  { id: 'files', label: 'Files', icon: <FileText size={15} /> },
  { id: 'plugins', label: 'Plugins', icon: <Puzzle size={15} /> },
  { id: 'stats', label: 'Statistics', icon: <Activity size={15} /> },
  { id: 'properties', label: 'Properties', icon: <SlidersHorizontal size={15} /> },
  { id: 'players', label: 'Players', icon: <Users size={15} /> },
  { id: 'backups', label: 'Backups & Schedule', icon: <Archive size={15} /> },
];

function Workspace() {
  const { selected, selectServer, servers, error, setError, notice, setNotice, dataDir, motd } = useApp();
  const [tab, setTab] = useState<Tab>('main');
  const [showAdd, setShowAdd] = useState(false);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="redstone-logo">
            <Zap size={28} fill="currentColor" />
          </div>
          <div>
            <strong>RedstonePanel</strong>
            <span>Desktop Server HQ</span>
          </div>
        </div>
        <nav className="server-list" aria-label="Managed servers">
          {servers.length === 0 && (
            <div className="empty-list">
              No servers yet.
              <br />
              Create one to get started.
            </div>
          )}
          {servers.map((server) => (
            <button
              key={server.id}
              className={server.id === selected?.id ? 'server-card active' : 'server-card'}
              onClick={() => selectServer(server.id)}
            >
              <Server size={18} className={server.running ? 'dot-on' : 'dot-off'} />
              <span>
                <strong>{server.name}</strong>
                <small>{server.running ? 'Running' : 'Stopped'}</small>
                {KIND_LABEL[server.kind] && server.version && (
                  <small className="server-meta">
                    {KIND_LABEL[server.kind]} {server.version} · {server.ram_gb} GB RAM
                  </small>
                )}
              </span>
            </button>
          ))}
        </nav>
        {dataDir && (
          <div className="storage-line" title={dataDir}>
            Storage: {dataDir}
          </div>
        )}
        <AddServerButton onOpen={() => setShowAdd(true)} />
      </aside>

      <section className="workspace">
        <header className="hero">
          <div>
            <p className="eyebrow">{selected ? `servers/${selected.id}` : 'no server selected'}</p>
            <h1>{selected?.name ?? 'RedstonePanel'}</h1>
            {selected && (
              <div className="motd-strip hero-motd">
                {stripMcText(motd) ? (
                  <span className="motd-text">{renderMcText(motd)}</span>
                ) : (
                  <span className="console-empty">Set your MOTD in the Properties tab</span>
                )}
              </div>
            )}
            <p>A native local-hosting control center — pick a server and run it from your desktop.</p>
          </div>
          {selected && (
            <div className="hero-status">
              <span className="status-chip" data-state={selected.running ? 'on' : 'off'}>
                {selected.running ? 'ONLINE' : 'OFFLINE'}
              </span>
              <small>{KIND_LABEL[selected.kind]} {selected.version}</small>
            </div>
          )}
        </header>

        {error && (
          <div className="banner error-banner">
            <span>{error}</span>
            <button className="banner-close" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="banner notice-banner">
            <span>{notice}</span>
            <button className="banner-close" onClick={() => setNotice(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        <nav className="tabbar" aria-label="Server sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              disabled={!selected}
              onClick={() => setTab(t.id)}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </nav>

        <div className="tab-content">
          {tab === 'main' && <MainTab />}
          {tab === 'files' && <FilesTab />}
          {tab === 'plugins' && <PluginsTab />}
          {tab === 'stats' && <StatsTab />}
          {tab === 'properties' && <PropertiesTab />}
          {tab === 'players' && <PlayersTab />}
          {tab === 'backups' && <BackupsTab />}
        </div>
      </section>

      <AddServerModal open={showAdd} onClose={() => setShowAdd(false)} />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <AppProvider>
    <Workspace />
  </AppProvider>,
);
