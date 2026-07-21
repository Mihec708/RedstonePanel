import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  CirclePower,
  Clock3,
  Cloud,
  FileTree,
  Gamepad2,
  HardDriveDownload,
  Image,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Skull,
  Square,
  TerminalSquare,
  Users,
  Zap,
} from 'lucide-react';
import './styles.css';

type ServerStatus = 'Online' | 'Starting' | 'Offline';

type ManagedServer = {
  id: number;
  name: string;
  type: string;
  status: ServerStatus;
  path: string;
  cpu: number;
  ram: number;
  tps: number;
};

const servers: ManagedServer[] = [
  { id: 1, name: 'Quartz SMP', type: 'Paper 1.21', status: 'Online', path: '~/Servers/quartz-smp', cpu: 24, ram: 58, tps: 19.9 },
  { id: 2, name: 'Create Lab', type: 'Forge', status: 'Starting', path: '~/Servers/create-lab', cpu: 61, ram: 72, tps: 17.6 },
  { id: 3, name: 'Fabric Tests', type: 'Fabric', status: 'Offline', path: '~/Servers/fabric-tests', cpu: 0, ram: 0, tps: 0 },
];

const consoleLines = [
  '§a[12:01:14 INFO] Starting minecraft server version 1.21',
  '§e[12:01:16 WARN] Missing optional plugin LuckPerms-Chat',
  '§b[12:01:20 INFO] Preparing spawn area: 100%',
  '§a[12:01:22 INFO] Done (8.421s)! For help, type "help"',
  '§c[12:03:41 INFO] Alex joined the game',
];

const files = ['server.properties', 'world/', 'plugins/', 'mods/', 'config/', 'logs/latest.log', 'ops.json', 'banned-players.json'];
const players = ['Alex', 'Steve', 'Rana', 'Noor'];
const backups = ['Today 12:00 — Pre-mod snapshot', 'Yesterday 03:00 — Scheduled backup', 'Jul 18 20:14 — Before Nether reset'];
const mods = ['Lithium', 'Simple Voice Chat', 'WorldEdit', 'BlueMap'];

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
  const [selectedId, setSelectedId] = useState(1);
  const selected = servers.find((server) => server.id === selectedId) ?? servers[0];
  const telemetry = useMemo(() => ({
    cpu: [20, 23, 19, 34, 31, selected.cpu, 26, 29],
    ram: [42, 48, 51, 50, 54, selected.ram, 57, 59],
    tps: [99, 97, 96, 100, 98, Math.round(selected.tps * 5), 99, 100],
  }), [selected]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="redstone-logo"><Zap size={28} fill="currentColor" /></div>
          <div><strong>RedstonePanel</strong><span>Desktop Server HQ</span></div>
        </div>
        <nav className="server-list" aria-label="Managed servers">
          {servers.map((server) => (
            <button key={server.id} className={server.id === selectedId ? 'server-card active' : 'server-card'} onClick={() => setSelectedId(server.id)}>
              <Server size={18} />
              <span><strong>{server.name}</strong><small>{server.type} · {server.status}</small></span>
            </button>
          ))}
        </nav>
        <button className="add-server"><Plus size={24} /> Add server</button>
      </aside>

      <section className="workspace">
        <header className="hero">
          <div>
            <p className="eyebrow">{selected.path}</p>
            <h1>{selected.name}</h1>
            <p>A native local-hosting control center with live process monitoring, backups, mods, and no-router sharing.</p>
          </div>
          <div className="power-actions">
            <button><Play size={16} />Start</button><button><Square size={16} />Stop</button><button><RefreshCw size={16} />Restart</button><button className="danger"><CirclePower size={16} />Force Kill</button>
          </div>
        </header>

        <section className="grid three">
          <Metric title="CPU" value={`${selected.cpu}%`} tone="red" values={telemetry.cpu} />
          <Metric title="RAM" value={`${selected.ram}%`} tone="gold" values={telemetry.ram} />
          <Metric title="TPS" value={selected.tps.toFixed(1)} tone="green" values={telemetry.tps} />
        </section>

        <section className="grid two">
          <Panel icon={<TerminalSquare />} title="Live Interactive Console" action={<label><input type="checkbox" defaultChecked /> Autoscroll</label>}>
            <div className="console-toolbar"><Search size={15} /> <input placeholder="Search history" /></div>
            <pre className="console">{consoleLines.map((line) => <React.Fragment key={line}>{colorizeMinecraft(line)}{`\n`}</React.Fragment>)}</pre>
            <div className="command-bar"><input placeholder="say Welcome to RedstonePanel" /><button>Send</button></div>
          </Panel>
          <Panel icon={<FileTree />} title="Branch File Manager & Code Editor">
            <div className="tree">{files.map((file) => <button key={file}>├─ {file}</button>)}</div>
            <textarea spellCheck={false} defaultValue={'motd=§cRedstonePanel §7SMP\nmax-players=20\ngamemode=survival'} />
          </Panel>
        </section>

        <section className="grid two">
          <Panel icon={<Gamepad2 />} title="Smart server.properties Editor">
            <div className="form-grid"><label>Gamemode<select><option>Survival</option><option>Creative</option></select></label><label>Difficulty<select><option>Normal</option></select></label><label>Max Players<input type="number" defaultValue={20} /></label><label className="toggle">PVP<input type="checkbox" defaultChecked /></label></div>
            <button className="muted">Switch to manual raw mode</button>
          </Panel>
          <Panel icon={<Users />} title="Player Management">
            {players.map((player) => <div className="player" key={player}><img src={`https://api.dicebear.com/9.x/pixel-art/svg?seed=${player}`} alt="" /><strong>{player}</strong><button>OP</button><button>Kick</button><button>Ban</button><select><option>Survival</option><option>Creative</option></select></div>)}
          </Panel>
        </section>

        <section className="grid three">
          <Panel icon={<Archive />} title="Backups & Time Machine"><button className="primary">Take Snapshot</button>{backups.map((b) => <div className="timeline" key={b}>{b}<button>Restore</button></div>)}</Panel>
          <Panel icon={<Clock3 />} title="Visual Task Scheduler"><div className="task">Restart daily at 3 AM</div><div className="task">Backup every 6 hours</div><div className="task">Broadcast every 30 minutes</div></Panel>
          <Panel icon={<HardDriveDownload />} title="Modded Wizard & Browser"><div className="chips"><span>Vanilla</span><span>Paper</span><span>Forge</span><span>Fabric</span><span>Quilt</span></div>{mods.map((mod) => <div className="mod" key={mod}>{mod}<button>Install</button></div>)}</Panel>
        </section>

        <section className="grid two">
          <Panel icon={<Image />} title="Server Icon Manager & Visual MOTD"><div className="icon-preview"><Skull /> 64×64</div><button>Upload and crop icon</button><div className="motd"><span className="mc-red">RedstonePanel</span> <span>— Quartz SMP</span></div></Panel>
          <Panel icon={<Cloud />} title="No-Router Port Forwarding"><label className="share-toggle"><input type="checkbox" /> Enable playit.gg / Cloudflared tunnel</label><div className="share-url">example.playit.gg:25565</div></Panel>
        </section>
      </section>
    </main>
  );
}

function Metric({ title, value, values, tone }: { title: string; value: string; values: number[]; tone: 'red' | 'gold' | 'green' }) {
  return <article className="metric"><span>{title}</span><strong>{value}</strong><Sparkline values={values} tone={tone} /></article>;
}

function Panel({ icon, title, action, children }: { icon: React.ReactNode; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <article className="panel"><header><span className="panel-icon">{icon}</span><h2>{title}</h2>{action}</header>{children}</article>;
}

createRoot(document.getElementById('root')!).render(<App />);
