import { invoke } from '@tauri-apps/api/core';
import type {
  BackupInfo,
  FileEntry,
  PlayerInfo,
  Schedule,
  ServerInfo,
  ServerStats,
} from './types';

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ---- servers ----
export const ensureDataDir = () => invoke<string>('ensure_data_dir');
export const listServers = () => invoke<ServerInfo[]>('list_servers');
export const createServer = (
  name: string,
  kind: string,
  version: string,
  ramGb: number,
) => invoke<ServerInfo>('create_server', { name, kind, version, ramGb });
export const listVersions = (kind: string) =>
  invoke<string[]>('list_versions', { kind });
export const downloadServer = (id: string, kind: string, version: string) =>
  invoke<string>('download_server', { id, kind, version });
export const openServerDir = (id: string) =>
  invoke<string>('open_server_dir', { id });

// ---- power + console ----
export const startServer = (id: string) => invoke<string>('start_server', { id });
export const stopServer = (id: string) => invoke<string>('stop_server', { id });
export const sendConsole = (id: string, line: string) =>
  invoke<string>('send_console', { id, line });

// ---- files ----
export const listFiles = (id: string) => invoke<FileEntry[]>('list_files', { id });
export const readFile = (id: string, path: string) =>
  invoke<string>('read_file', { id, path });
export const writeFile = (id: string, path: string, content: string) =>
  invoke<string>('write_file', { id, path, content });

// ---- stats ----
export const serverStats = (id: string) =>
  invoke<ServerStats>('server_stats', { id });

// ---- players ----
export const listPlayers = (id: string) => invoke<PlayerInfo[]>('list_players', { id });
export const listWhitelist = (id: string) =>
  invoke<PlayerInfo[]>('list_whitelist', { id });
export const whitelistStatus = (id: string) => invoke<boolean>('whitelist_status', { id });
export const setWhitelist = (id: string, enabled: boolean) =>
  invoke<string>('set_whitelist', { id, enabled });

// ---- backups ----
export const createBackup = (id: string) => invoke<string>('create_backup', { id });
export const listBackups = (id: string) => invoke<BackupInfo[]>('list_backups', { id });
export const restoreBackup = (id: string, name: string) =>
  invoke<string>('restore_backup', { id, name });
export const deleteBackup = (id: string, name: string) =>
  invoke<string>('delete_backup', { id, name });

// ---- scheduler ----
export const listSchedules = (id: string) => invoke<Schedule[]>('list_schedules', { id });
export const addSchedule = (
  id: string,
  action: string,
  delaySecs: number,
  repeat: string,
  command: string | null,
) =>
  invoke<Schedule[]>('add_schedule', {
    id,
    action,
    delaySecs,
    repeat,
    command,
  });
export const removeSchedule = (id: string, sid: number) =>
  invoke<Schedule[]>('remove_schedule', { id, sid });

// ---- plugins ----
export const installPlugin = (
  id: string,
  url: string,
  filename: string,
) => invoke<string>('install_plugin', { id, url, filename });
