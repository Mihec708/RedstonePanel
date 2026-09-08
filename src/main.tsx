import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Archive,
  CirclePower,
  Clock3,
  Cloud,
  FolderOpen,
  FolderTree,
  Gamepad2,
  HardDriveDownload,
  Image,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Skull,
  Square,
  TerminalSquare,
  Users,
  Zap,
} from 'lucide-react';
import './styles.css';

type ServerInfo = { id: string; name: string; running: boolean; kind: string; version: string; ram_gb: number };

const KIND_LABEL: Record<string, string> = {
  vanilla: 'Vanilla',
  paper: 'Paper',
  bungeecord: 'BungeeCord',
  custom: 'Custom',
};
type ConsoleLine = { id: string; line: string; source: string };
type FileEntry = { name: string; dir: boolean };
type Telemetry = { cpu_usage: number; used_memory: number; total_memory: number };

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function colorizeMinecraft(line: string) {
  const classMap: Record<string, string> = { '§a': 'mc-green', '§b': 'mc-aqua', '§c': 'mc-red', '§e': 'mc-yellow' };
  const code = line.slice(0, 2);
  return <span className={classMap[code] ?? ''}>{line.replace(/§[0-9a-fk-or]/gi, '')}</span>;
}

function Sparkline({ values, tone }: { values: number[]; tone: 'red' | 'gold' | 'green' }) {
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${42 - value * 0.36}`).join(' ');
  return (
    <svg className={`sparkline ${tone}`} viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function App() {
  const [dataDir, setDataDir] = useState('');
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [history, setHistory] = useState<{ cpu: number[]; ram: number[] }>({ cpu: [], ram: [] });
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileText, setFileText] = useState('');
  const [ramInfo, setRamInfo] = useState<{ used: number; allocated: number } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('paper');
  const [newVersion, setNewVersion] = useState('');
  const [ramGb, setRamGb] = useState(2);
  const [versions, setVersions] = useState<string[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dlBytes, setDlBytes] = useState(0);
  const consoleRef = useRef<HTMLPreElement>(null);

  const selected = servers.find((server) => server.id === selectedId) ?? null;
  const selectedLines = selected ? lines.filter((line) => line.id === selected.id) : [];

  // The polling interval below is created once; keep a live ref to the
  // currently selected server so it can query per-server RAM.
  const selRef = useRef<{ id: string | null; running: boolean }>({ id: null, running: false });
  selRef.current = { id: selectedId, running: Boolean(selected?.running) };

  const refreshServers = useCallback(async () => {
    const list = await invoke<ServerInfo[]>('list_servers');
    setServers(list);
    setSelectedId((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? null));
    return list;
  }, []);

  const loadVersions = useCallback(async (kind: string) => {
    setVersionsLoading(true);
    setVersions([]);
    setNewVersion('');
    try {
      const list = await invoke<string[]>('list_versions', { kind });
      setVersions(list);
      setNewVersion(list[0] ?? '');
    } catch {
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  const loadFiles = useCallback(async (id: string) => {
    try {
      const list = await invoke<FileEntry[]>('list_files', { id });
      setFiles(list);
    } catch {
      setFiles([]);
    }
    setOpenFile(null);
    setFileText('');
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    invoke<string>('ensure_data_dir').then(setDataDir).catch((e) => setError(String(e)));
    refreshServers()
      .then((list) => list[0] && loadFiles(list[0].id))
      .catch((e) => setError(String(e)));
    invoke<Telemetry>('host_telemetry').then(setTelemetry).catch(() => {});
    listen<ConsoleLine>('server-console', (event) => {
      setLines((prev) => [...prev.slice(-1500), event.payload]);
    }).then((off) => unlisteners.push(off)).catch(() => {});
    listen<{ id: string; code: number }>('server-exit', () => {
      refreshServers().catch(() => {});
    }).then((off) => unlisteners.push(off)).catch(() => {});
    const poll = setInterval(async () => {
      const t = await invoke<Telemetry>('host_telemetry').catch(() => null);
      if (!t) return;
      setTelemetry(t);
      let ramUsed: number | null = null;
      let ramAlloc: number | null = null;
      const s = selRef.current;
      if (s.id && s.running) {
        try {
          const r = await invoke<{ used: number; allocated: number }>('server_ram', { id: s.id });
          ramUsed = r.used;
          ramAlloc = r.allocated;
        } catch {
          /* not running / no process info yet */
        }
      }
      const cpuPct = t.cpu_usage ?? 0;
      const ramPct =
        ramUsed != null && ramAlloc
          ? (ramUsed / ramAlloc) * 100
          : t.total_memory > 0
            ? (t.used_memory / t.total_memory) * 100
            : 0;
      setRamInfo(ramUsed != null && ramAlloc ? { used: ramUsed, allocated: ramAlloc } : null);
      setHistory((h) => ({
        cpu: [...h.cpu, cpuPct].slice(-12),
        ram: [...h.ram, Math.min(ramPct, 100)].slice(-12),
      }));
    }, 3000);
    return () => {
      clearInterval(poll);
      unlisteners.forEach((off) => off());
    };
  }, [refreshServers, loadFiles]);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selectedLines.length, selectedId]);

  useEffect(() => {
    if (selectedId) loadFiles(selectedId);
  }, [selectedId, loadFiles]);

  async function power(action: 'start' | 'stop') {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await invoke<string>(action === 'start' ? 'start_server' : 'stop_server', { id: selected.id });
      setNotice(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refreshServers().catch(() => {});
    }
  }

  async function restart() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (selected.running) {
        try { await invoke('stop_server', { id: selected.id }); } catch { /* may not be running */ }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      const result = await invoke<string>('start_server', { id: selected.id });
      setNotice(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refreshServers().catch(() => {});
    }
  }

  function openAddModal() {
    setShowAdd(true);
    setError(null);
    setNotice(null);
    setDlBytes(0);
    loadVersions(newKind);
  }

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
      const created = await invoke<ServerInfo>('create_server', {
        name,
        kind: newKind,
        version: newVersion,
        ramGb: Number(ramGb) || 2,
      });
      const msg = await invoke<string>('download_server', {
        id: created.id,
        kind: newKind,
        version: newVersion,
      });
      if (off) off();
      setShowAdd(false);
      setNewName('');
      setNotice(`${created.name}: ${msg}`);
      await refreshServers();
      setSelectedId(created.id);
      loadFiles(created.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function openFolder(id: string) {
    setError(null);
    try {
      await invoke('open_server_dir', { id });
    } catch (e) {
      setError(String(e));
    }
  }

  async function sendCommand() {
    const line = command.trim();
    if (!line || !selected) return;
    setCommand('');
    try {
      await invoke('send_console', { id: selected.id, line });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openFileEntry(entry: FileEntry) {
    if (entry.dir || !selected) return;
    setError(null);
    try {
      const text = await invoke<string>('read_file', { id: selected.id, path: entry.name });
      setOpenFile(entry.name);
      setFileText(text);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveFile() {
    if (!openFile || !selected) return;
    setError(null);
    try {
      await invoke('write_file', { id: selected.id, path: openFile, content: fileText });
      setNotice(`${openFile} saved`);
    } catch (e) {
      setError(String(e));
    }
  }

  const ramPct = telemetry && telemetry.total_memory > 0 ? Math.round((telemetry.used_memory / telemetry.total_memory) * 100) : 0;
  const cpuValues = history.cpu.length ? history.cpu : [0, 0];
  const ramValues = history.ram.length ? history.ram : [0, 0];
  const onlineValues = servers.map((s) => (s.running ? 1 : 0));

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="redstone-logo"><Zap size={28} fill="currentColor" /></div>
          <div><strong>RedstonePanel</strong><span>Desktop Server HQ</span></div>
        </div>
        <nav className="server-list" aria-label="Managed servers">
          {servers.length === 0 && (
            <div className="empty-list">
              No servers yet.<br />Create one to get started.
            </div>
          )}
          {servers.map((server) => (
            <button key={server.id} className={server.id === selectedId ? 'server-card active' : 'server-card'} onClick={() => setSelectedId(server.id)}>
              <Server size={18} className={server.running ? 'dot-on' : 'dot-off'} />
              <span>
                <strong>{server.name}</strong>
                <small>{server.running ? 'Running' : 'Stopped'}</small>
                {KIND_LABEL[server.kind] && server.version && (
                  <small className="server-meta">{KIND_LABEL[server.kind]} {server.version} · {server.ram_gb} GB RAM</small>
                )}
              </span>
            </button>
          ))}
        </nav>
        {dataDir && <div className="storage-line" title={dataDir}>Storage: {dataDir}</div>}
        <button className="add-server" onClick={openAddModal} disabled={creating}><Plus size={24} /> Add server</button>
      </aside>

      <section className="workspace">
        <header className="hero">
          <div>
            <p className="eyebrow">{selected ? `servers/${selected.id}` : 'no server selected'}</p>
            <h1>{selected?.name ?? 'RedstonePanel'}</h1>
            <p>A native local-hosting control center — pick a server and run it from your desktop.</p>
          </div>
          <div className="power-actions">
            <button disabled={!selected || busy} onClick={() => power('start')}><Play size={16} />Start</button>
            <button disabled={!selected || busy} onClick={() => power('stop')}><Square size={16} />Stop</button>
            <button disabled={!selected || busy} onClick={restart}><RefreshCw size={16} />Restart</button>
            <button className="danger" disabled={!selected || busy} onClick={() => power('stop')}><CirclePower size={16} />Force Kill</button>
          </div>
        </header>

        {error && <div className="banner error-banner">{error}</div>}
        {notice && <div className="banner notice-banner">{notice}</div>}

        <section className="grid three">
          <Metric title="Host CPU" value={telemetry ? `${telemetry.cpu_usage.toFixed(1)}%` : '—'} tone="red" values={cpuValues} />
          <Metric
            title={ramInfo ? 'Server RAM' : 'Host RAM'}
            value={ramInfo
              ? `${(ramInfo.used / 2 ** 30).toFixed(1)} / ${(ramInfo.allocated / 2 ** 30).toFixed(1)} GB`
              : telemetry
                ? `${ramPct}% · ${(telemetry.used_memory / 2 ** 30).toFixed(1)}/${(telemetry.total_memory / 2 ** 30).toFixed(1)} GB`
                : '—'}
            tone="gold"
            values={ramValues}
          />
          <Metric title="Servers" value={selected ? (selected.running ? 'ONLINE' : 'OFFLINE') : '—'} tone="green" values={onlineValues.length ? onlineValues : [0, 0]} />
        </section>

        <section className="grid two">
          <Panel icon={<TerminalSquare />} title={`Live Console${selected ? ` — ${selected.name}` : ''}`} action={<span className="planned-chip live">LIVE</span>}>
            <div className="console-toolbar"><Search size={15} /> <span className="toolbar-hint">Console output is streamed in real time</span></div>
            <pre className="console" ref={consoleRef}>
              {selectedLines.length === 0
                ? <span className="console-empty">{selected ? (selected.running ? 'Waiting for output…' : 'Server is stopped. Press Start to begin.') : 'Select a server to see its console.'}</span>
                : selectedLines.map((line, index) => <React.Fragment key={index}>{colorizeMinecraft(line.line)}{`\n`}</React.Fragment>)}
            </pre>
            <div className="command-bar">
              <input
                value={command}
                placeholder={selected ? 'say Welcome to RedstonePanel' : 'select a server first'}
                disabled={!selected}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && sendCommand()}
              />
              <button disabled={!selected || !command.trim()} onClick={sendCommand}>Send</button>
            </div>
          </Panel>
          <Panel icon={<FolderTree />} title={`Server Files${selected ? ` — ${selected.name}` : ''}`} action={
            <span className="panel-actions">
              {selected && <button onClick={() => openFolder(selected.id)}><FolderOpen size={14} /> Open folder</button>}
              <span className="planned-chip live">LIVE</span>
            </span>
          }>
            <div className="tree">
              {files.length === 0 && <span className="toolbar-hint">No files yet — this is the server folder.</span>}
              {files.map((file) => (
                <button key={file.name} className={openFile === file.name ? 'file-active' : ''} disabled={file.dir} onClick={() => openFileEntry(file)}>
                  {file.dir ? '▸' : '├'} {file.name}
                </button>
              ))}
            </div>
            {openFile ? (
              <>
                <textarea value={fileText} spellCheck={false} onChange={(event) => setFileText(event.target.value)} />
                <div className="save-row">
                  <span className="toolbar-hint">editing {openFile}</span>
                  <button className="primary" onClick={saveFile}><Save size={14} /> Save file</button>
                </div>
              </>
            ) : (
              <p className="toolbar-hint">Click a file (like server.properties) to edit it, then Save.</p>
            )}
          </Panel>
        </section>

        <section className="grid two">
          <Panel icon={<Gamepad2 />} title="Smart server.properties Editor" planned>
            <div className="form-grid"><label>Gamemode<select><option>Survival</option><option>Creative</option></select></label><label>Difficulty<select><option>Normal</option></select></label><label>Max Players<input type="number" defaultValue={20} /></label><label className="toggle">PVP<input type="checkbox" defaultChecked /></label></div>
            <button className="muted">Edit server.properties directly in the file panel above</button>
          </Panel>
          <Panel icon={<Users />} title="Player Management" planned>
            <div className="player"><span className="avatar">A</span><strong>Alex</strong><button>OP</button><button>Kick</button><button>Ban</button><select><option>Survival</option><option>Creative</option></select></div>
            <div className="player"><span className="avatar">S</span><strong>Steve</strong><button>OP</button><button>Kick</button><button>Ban</button><select><option>Survival</option><option>Creative</option></select></div>
            <div className="player"><span className="avatar">R</span><strong>Rana</strong><button>OP</button><button>Kick</button><button>Ban</button><select><option>Survival</option><option>Creative</option></select></div>
          </Panel>
        </section>

        <section className="grid three">
          <Panel icon={<Archive />} title="Backups & Time Machine" planned><button className="primary">Take Snapshot</button>{['Today 12:00 — Pre-mod snapshot', 'Yesterday 03:00 — Scheduled backup'].map((b) => <div className="timeline" key={b}>{b}<button>Restore</button></div>)}</Panel>
          <Panel icon={<Clock3 />} title="Visual Task Scheduler" planned><div className="task">Restart daily at 3 AM</div><div className="task">Backup every 6 hours</div><div className="task">Broadcast every 30 minutes</div></Panel>
          <Panel icon={<HardDriveDownload />} title="Modded Wizard & Browser" planned><div className="chips"><span>Vanilla</span><span>Paper</span><span>Forge</span><span>Fabric</span><span>Quilt</span></div>{['Lithium', 'Simple Voice Chat', 'WorldEdit'].map((mod) => <div className="mod" key={mod}>{mod}<button>Install</button></div>)}</Panel>
        </section>

        <section className="grid two">
          <Panel icon={<Image />} title="Server Icon Manager & Visual MOTD" planned><div className="icon-preview"><Skull /> 64×64</div><button>Upload and crop icon</button><div className="motd"><span className="mc-red">RedstonePanel</span> <span>— your server</span></div></Panel>
          <Panel icon={<Cloud />} title="No-Router Port Forwarding" planned><label className="share-toggle"><input type="checkbox" /> Enable playit.gg / Cloudflared tunnel</label><div className="share-url">example.playit.gg:25565</div></Panel>
        </section>
      </section>

      {showAdd && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) setShowAdd(false); }}>
          <div className="modal">
            <h2>Add a server</h2>
            <label>Name<input value={newName} placeholder="my-minecraft-server" onChange={(event) => setNewName(event.target.value)} disabled={creating} /></label>
            <div className="form-grid">
              <label>Server type
                <select value={newKind} disabled={creating} onChange={(event) => { const kind = event.target.value; setNewKind(kind); loadVersions(kind); }}>
                  <option value="paper">Paper</option>
                  <option value="vanilla">Vanilla</option>
                  <option value="bungeecord">BungeeCord</option>
                </select>
              </label>
              <label>Version
                <select value={newVersion} disabled={versionsLoading || creating || newKind === 'paper' || newKind === 'bungeecord'} onChange={(event) => setNewVersion(event.target.value)}>
                  {newKind === 'paper' && <option value="latest">Latest stable (auto)</option>}
                  {newKind === 'bungeecord' && <option value="latest">Latest</option>}
                  {newKind === 'vanilla' && (versionsLoading ? <option value="">Loading versions…</option> : versions.map((v) => <option key={v} value={v}>{v}</option>))}
                </select>
              </label>
              <label>RAM (GB)
                <input type="number" min={1} max={32} value={ramGb} disabled={creating} onChange={(event) => setRamGb(Number(event.target.value))} />
              </label>
            </div>
            <p className="toolbar-hint">The server jar is downloaded automatically from the official source — no manual setup.</p>
            {creating && dlBytes > 0 && <div className="dl-progress">Downloading… {(dlBytes / 2 ** 20).toFixed(1)} MB</div>}
            <div className="modal-actions">
              <button disabled={creating} onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="primary" disabled={creating || !newName.trim()} onClick={createAndDownload}>
                {creating ? 'Creating & downloading…' : 'Create & download'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Metric({ title, value, values, tone }: { title: string; value: string; values: number[]; tone: 'red' | 'gold' | 'green' }) {
  return <article className="metric"><span>{title}</span><strong>{value}</strong><Sparkline values={values} tone={tone} /></article>;
}

function Panel({ icon, title, action, planned, children }: { icon: React.ReactNode; title: string; action?: React.ReactNode; planned?: boolean; children: React.ReactNode }) {
  return (
    <article className="panel">
      <header>
        <span className="panel-icon">{icon}</span>
        <h2>{title}</h2>
        {planned && !action && <span className="planned-chip">PLANNED</span>}
        {action}
      </header>
      {children}
    </article>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
