export type ServerInfo = {
  id: string;
  name: string;
  running: boolean;
  kind: string;
  version: string;
  ram_gb: number;
};

export type ConsoleLine = { id: string; line: string; source: string };

export type FileEntry = { name: string; dir: boolean };

export type ServerStats = {
  cpu: number;
  ram_used: number;
  ram_alloc: number;
  uptime_secs: number;
};

export type BackupInfo = { name: string; size: number; mtime: number };

export type PlayerInfo = { name: string; uuid: string };

export type Schedule = {
  sid: number;
  action: string;
  next_run: number;
  repeat: string;
  command?: string | null;
};

export type PluginHit = {
  title: string;
  description: string;
  downloads: number;
  icon_url: string | null;
  slug: string;
};

export type Tab =
  | 'main'
  | 'files'
  | 'plugins'
  | 'stats'
  | 'properties'
  | 'players'
  | 'backups';

export const KIND_LABEL: Record<string, string> = {
  vanilla: 'Vanilla',
  paper: 'Paper',
  bungeecord: 'BungeeCord',
  custom: 'Custom',
};
