import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock, Download, Heart, Search } from 'lucide-react';
import { useApp } from '../AppContext';
import * as api from '../api';
import type { PluginHit } from '../types';

const API = 'https://api.modrinth.com/v2';

/** Category names that identify a server loader (shown as colored chips, like Modrinth). */
const LOADER_CATS = new Set([
  'bukkit',
  'paper',
  'spigot',
  'folia',
  'purpur',
  'sponge',
  'velocity',
  'bungeecord',
  'waterfall',
  'quilt',
  'fabric',
  'forge',
  'neoforge',
]);

type RawHit = {
  project_id: string;
  title: string;
  description: string;
  author: string;
  icon_url: string | null;
  downloads: number;
  follows: number;
  categories: string[];
  date_modified: string;
};

const SORTS = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'follows', label: 'Follows' },
  { id: 'updated', label: 'Last updated' },
] as const;
type SortId = (typeof SORTS)[number]['id'];

const VIEWS = [12, 24, 48];

// Robust JSON fetch: retries on a truncated/failed body so a flaky
// network blip ("Unterminated string in JSON...") doesn't crash the tab.
async function fetchJson(url: string, attempts = 2): Promise<unknown> {
  let lastErr: unknown = new Error('could not read the plugin list');
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Modrinth request failed (${res.status})`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      await new Promise((release) => setTimeout(release, 300));
    }
  }
  throw lastErr;
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min > 1 ? 's' : ''} ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 2) return 'last month';
  if (mo < 12) return `${mo} months ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y > 1 ? 's' : ''} ago`;
}

function titleCase(s: string): string {
  return s
    .split(/[-_ ]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Page numbers with ellipses: 1 … 4 5 6 … 880 */
function pageWindow(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = new Set([1, 2, current - 1, current, current + 1, total - 1, total]);
  const list = [...wanted].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  let prev = 0;
  for (const p of list) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

export function PluginsTab() {
  const { selected, setError, setNotice } = useApp();
  const [input, setInput] = useState('');
  const [applied, setApplied] = useState('');
  const [sort, setSort] = useState<SortId>('relevance');
  const [view, setView] = useState(24);
  const [page, setPage] = useState(1);
  const [hits, setHits] = useState<PluginHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', String(view));
      params.set('offset', String((page - 1) * view));
      params.set('sort', sort);
      params.set('facets', JSON.stringify([['project_types:plugin']]));
      if (applied) params.set('query', applied);
      const payload = (await fetchJson(`${API}/search?${params}`)) as
        | RawHit[]
        | { hits?: RawHit[]; total_hits?: number };
      const isList = Array.isArray(payload);
      const raw = isList ? (payload as RawHit[]) : (payload.hits ?? []);
      setTotalHits(isList ? raw.length : payload.total_hits ?? 0);
      setHits(
        raw.map((h) => {
          const cats = (h.categories ?? []).map((c) => c.toLowerCase());
          return {
            id: h.project_id,
            title: h.title,
            description: h.description,
            author: h.author ?? '',
            icon_url: h.icon_url ?? null,
            downloads: h.downloads ?? 0,
            follows: h.follows ?? 0,
            loaders: cats.filter((c) => LOADER_CATS.has(c)),
            categories: cats.filter((c) => !LOADER_CATS.has(c)),
            updated_at: h.date_modified ?? '',
          };
        }),
      );
    } catch (e) {
      setHits([]);
      setTotalHits(0);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [applied, sort, view, page, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!selected) {
    return <div className="tab-empty">Select or add a server to browse plugins for it.</div>;
  }

  function submit() {
    setPage(1);
    setApplied(input.trim());
  }

  function goTo(p: number) {
    const max = Math.max(1, Math.ceil(totalHits / view));
    setPage(Math.min(max, Math.max(1, p)));
  }

  async function install(hit: PluginHit) {
    if (installing) return;
    setInstalling(hit.id);
    setError(null);
    setNotice(null);
    try {
      const versions = (await fetchJson(
        `${API}/project/${encodeURIComponent(hit.id)}/version`,
      )) as Array<{ files?: Array<{ url: string; filename?: string }> }>;
      const file = versions.find((v) => Array.isArray(v.files) && v.files.length > 0)?.files?.[0];
      if (!file) throw new Error('No downloadable versions found');
      const filename = file.filename || file.url.split('/').pop() || 'plugin.jar';
      const result = await api.installPlugin(selected!.id, file.url, filename);
      setNotice(`Installed ${hit.title} → ${result}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalHits / view));

  return (
    <div className="tab-body">
      <section className="panel">
        <header>
          <h2>Plugin Browser</h2>
          <span className="planned-chip live">MODRINTH</span>
        </header>
        <p className="toolbar-hint">
          Search the Modrinth library of Bukkit/Paper/Spigot plugins.{' '}
          <strong>Install</strong> drops the jar straight into{' '}
          <code>{selected.name}</code>'s folder (restart the server to load it).
        </p>
        <div className="command-bar plugin-search">
          <Search size={16} />
          <input
            value={input}
            placeholder="Search plugins… (e.g. LuckPerms, WorldEdit, VeinMiner)"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
          />
          <button onClick={submit}>Search</button>
        </div>
        <div className="plugin-toolbar">
          <label className="tool">
            Sort by:
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as SortId);
                setPage(1);
              }}
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="tool">
            View:
            <select
              value={view}
              onChange={(e) => {
                setView(Number(e.target.value));
                setPage(1);
              }}
            >
              {VIEWS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <span className="tool-muted">{totalHits.toLocaleString()} results</span>
          <div className="pagination">
            <button className="page-btn" disabled={page <= 1} onClick={() => goTo(page - 1)} aria-label="Previous page">
              <ChevronLeft size={14} />
            </button>
            {pageWindow(page, totalPages).map((p, i) =>
              p === '…' ? (
                <span key={`e${i}`} className="page-ellipsis">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  className={p === page ? 'page-btn active' : 'page-btn'}
                  onClick={() => goTo(p)}
                >
                  {p}
                </button>
              ),
            )}
            <button
              className="page-btn"
              disabled={page >= totalPages}
              onClick={() => goTo(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </section>

      {loading && <div className="banner notice-banner">Loading plugins…</div>}
      {!loading && hits.length === 0 && (
        <div className="banner notice-banner">No plugins found — try a different search.</div>
      )}

      <div className="plugin-list">
        {hits.map((hit) => {
          const shownCats = hit.categories.slice(0, 3);
          const extra = hit.categories.length - shownCats.length;
          return (
            <article className="mod-card" key={hit.id}>
              <div className="mod-icon">
                {hit.icon_url ? <img src={hit.icon_url} alt="" /> : <span>?</span>}
              </div>
              <div className="mod-main">
                <div className="mod-title-row">
                  <strong>{hit.title}</strong>
                  {hit.author && <span className="mod-author">by {hit.author}</span>}
                </div>
                <p className="mod-desc">{hit.description}</p>
                <div className="mod-chips">
                  {shownCats.map((c) => (
                    <span key={c} className="chip">
                      {titleCase(c)}
                    </span>
                  ))}
                  {hit.loaders.map((c) => (
                    <span key={c} className="chip loader">
                      {titleCase(c)}
                    </span>
                  ))}
                  {extra > 0 && <span className="chip more">+{extra}</span>}
                </div>
              </div>
              <div className="mod-side">
                <span className="stat" title={`${hit.downloads.toLocaleString()} downloads`}>
                  <Download size={14} /> {fmtCount(hit.downloads)}
                </span>
                <span className="stat" title={`${hit.follows.toLocaleString()} follows`}>
                  <Heart size={14} /> {fmtCount(hit.follows)}
                </span>
                {hit.updated_at && (
                  <span className="stat" title={hit.updated_at}>
                    <Clock size={14} /> {timeAgo(hit.updated_at)}
                  </span>
                )}
                <button
                  className="install-btn"
                  disabled={Boolean(installing)}
                  onClick={() => install(hit)}
                >
                  <Download size={14} /> {installing === hit.id ? 'Installing…' : 'Install'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
