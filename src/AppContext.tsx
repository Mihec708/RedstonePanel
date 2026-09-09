import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { listen } from '@tauri-apps/api/event';
import * as api from './api';
import type { ConsoleLine, ServerInfo, ServerStats } from './types';
import { stripMcText } from './mcformat';

export type AppCtx = {
  dataDir: string;
  servers: ServerInfo[];
  selected: ServerInfo | null;
  selectServer: (id: string) => void;
  refreshServers: () => Promise<ServerInfo[]>;
  selectedLines: ConsoleLine[];
  stats: ServerStats | null;
  history: { cpu: number[]; ram: number[] };
  busy: boolean;
  setBusy: (b: boolean) => void;
  error: string | null;
  setError: (e: string | null) => void;
  notice: string | null;
  setNotice: (n: string | null) => void;
  motd: string;
  setMotd: (m: string) => void;
  power: (action: 'start' | 'stop' | 'restart' | 'kill') => Promise<void>;
  sendCommand: (line: string) => Promise<void>;
  openFolder: (id: string) => Promise<void>;
};

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

function readMotdFromProperties(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim().toLowerCase() === 'motd') {
      return line.slice(eq + 1).trim();
    }
  }
  return '';
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [dataDir, setDataDir] = useState('');
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [history, setHistory] = useState<{ cpu: number[]; ram: number[] }>({ cpu: [], ram: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [motd, setMotd] = useState('');
  const selRef = useRef<{ id: string | null; running: boolean }>({ id: null, running: false });

  const selected = servers.find((s) => s.id === selectedId) ?? null;
  selRef.current = { id: selectedId, running: Boolean(selected?.running) };
  const selectedLines = selected ? lines.filter((l) => l.id === selected.id) : [];

  const refreshServers = useCallback(async () => {
    const list = await api.listServers();
    setServers(list);
    setSelectedId((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? null));
    return list;
  }, []);

  const selectServer = useCallback((id: string) => {
    setSelectedId(id);
    setStats(null);
    setHistory({ cpu: [], ram: [] });
  }, []);

  // Load the MOTD whenever the selected server changes.
  useEffect(() => {
    if (!selectedId) {
      setMotd('');
      return;
    }
    let cancelled = false;
    api
      .readFile(selectedId, 'server.properties')
      .then((text) => {
        if (!cancelled) setMotd(readMotdFromProperties(text));
      })
      .catch(() => {
        if (!cancelled) setMotd('');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Initial load + console listeners + stats polling.
  useEffect(() => {
    if (!api.isTauri()) return;
    const unlisteners: Array<() => void> = [];
    api.ensureDataDir().then(setDataDir).catch((e) => setError(String(e)));
    refreshServers().catch((e) => setError(String(e)));
    listen<ConsoleLine>('server-console', (event) => {
      setLines((prev) => [...prev.slice(-1500), event.payload]);
    })
      .then((off) => unlisteners.push(off))
      .catch(() => {});
    listen<{ id: string; code: number }>('server-exit', () => {
      refreshServers().catch(() => {});
    })
      .then((off) => unlisteners.push(off))
      .catch(() => {});
    const poll = setInterval(async () => {
      const s = selRef.current;
      if (!s.id || !s.running) return;
      try {
        const r = await api.serverStats(s.id);
        setStats(r);
        const ramPct = r.ram_alloc > 0 ? Math.min((r.ram_used / r.ram_alloc) * 100, 100) : 0;
        setHistory((h) => ({
          cpu: [...h.cpu, r.cpu].slice(-40),
          ram: [...h.ram, ramPct].slice(-40),
        }));
      } catch {
        /* server process not yet visible */
      }
    }, 3000);
    return () => {
      clearInterval(poll);
      unlisteners.forEach((off) => off());
    };
  }, [refreshServers]);

  const power = useCallback(
    async (action: 'start' | 'stop' | 'restart' | 'kill') => {
      const server = selRef.current.id;
      if (!server) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        if (action === 'start' || action === 'kill') {
          const result = await (action === 'start' ? api.startServer(server) : api.stopServer(server));
          setNotice(result);
        } else if (action === 'stop' || action === 'restart') {
          if (action === 'restart' && selRef.current.running) {
            try {
              await api.stopServer(server);
            } catch {
              /* may already be stopped */
            }
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          if (action === 'restart') {
            const result = await api.startServer(server);
            setNotice(result);
          } else {
            const result = await api.stopServer(server);
            setNotice(result);
          }
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
        refreshServers().catch(() => {});
      }
    },
    [refreshServers],
  );

  const sendCommand = useCallback(async (line: string) => {
    const server = selRef.current.id;
    if (!server) return;
    try {
      await api.sendConsole(server, line);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openFolder = useCallback(async (id: string) => {
    setError(null);
    try {
      await api.openServerDir(id);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const value: AppCtx = {
    dataDir,
    servers,
    selected,
    selectServer,
    refreshServers,
    selectedLines,
    stats,
    history,
    busy,
    setBusy,
    error,
    setError,
    notice,
    setNotice,
    motd,
    setMotd,
    power,
    sendCommand,
    openFolder,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { stripMcText };
