import React, { useCallback, useEffect, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { useApp } from '../AppContext';
import * as api from '../api';
import type { PluginHit } from '../types';

type ModrinthSearchHit = {
  title: string;
  description: string;
  downloads: number;
  icon_url: string | null;
  project_id: string;
};

type ModrinthVersion = {
  version_number: string;
  file: { url: string; filename: string };
};

const SEARCH_URL = (query: string) =>
  `https://api.modrinth.com/v2/search?limit=24` +
  `&facets=${encodeURIComponent(JSON.stringify([['project_types:paper-plugin']]))}` +
  (query ? `&query=${encodeURIComponent(query)}` : '');

export function PluginsTab() {
  const { selected, setError, setNotice } = useApp();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PluginHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(SEARCH_URL(q));
      if (!res.ok) throw new Error(`Modrinth search failed (${res.status})`);
      const data = (await res.json()) as ModrinthSearchHit[];
      setHits(
        data.map((h) => ({
          title: h.title,
          description: h.description,
          downloads: h.downloads,
          icon_url: h.icon_url,
          slug: h.project_id,
        })),
      );
    } catch (e) {
      setHits([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load('');
  }, [load]);

  if (!selected) {
    return <div className="tab-empty">Select or add a server to browse plugins for it.</div>;
  }

  async function submitSearch() {
    load(query.trim());
  }

  async function install(hit: PluginHit) {
    if (installing) return;
    setInstalling(hit.slug);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(
        `https://api.modrinth.com/v2/project/${encodeURIComponent(hit.slug)}/version?loaders=${encodeURIComponent(JSON.stringify(['java']))}`,
      );
      if (!res.ok) throw new Error(`Could not fetch latest version (${res.status})`);
      const versions = (await res.json()) as ModrinthVersion[];
      if (versions.length === 0) throw new Error('No downloadable versions found');
      const file = versions[0].file;
      const result = await api.installPlugin(selected!.id, file.url, file.filename);
      setNotice(`Installed ${hit.title} → ${result}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  }

  return (
    <div className="tab-body">
      <section className="panel">
        <header>
          <h2>Plugin Browser</h2>
          <span className="planned-chip">MODRINTH</span>
        </header>
        <p className="toolbar-hint">
          Search the Modrinth library of Paper/Spigot plugins — install drops the jar straight into{' '}
          <code>{selected.name}</code>'s folder (restart the server to load it).
        </p>
        <div className="command-bar plugin-search">
          <Search size={16} />
          <input
            value={query}
            placeholder="Search plugins (e.g. LuckPerms, WorldEdit, Vault)…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submitSearch()}
          />
          <button onClick={submitSearch}>Search</button>
        </div>
      </section>

      {loading && <div className="banner notice-banner">Loading plugins…</div>}
      {!loading && hits.length === 0 && (
        <div className="banner notice-banner">No plugins found — try a different search.</div>
      )}

      <div className="plugin-grid">
        {hits.map((hit) => (
          <article className="plugin-card" key={hit.slug}>
            <div className="plugin-head">
              {hit.icon_url ? (
                <img className="plugin-icon" src={hit.icon_url} alt="" />
              ) : (
                <div className="plugin-icon placeholder">P</div>
              )}
              <div className="plugin-titles">
                <strong>{hit.title}</strong>
                <small>{hit.downloads.toLocaleString()} downloads</small>
              </div>
            </div>
            <p className="plugin-desc">{hit.description}</p>
            <div className="plugin-actions">
              <span className="toolbar-hint">Install into {selected.name}</span>
              <button className="primary" disabled={Boolean(installing)} onClick={() => install(hit)}>
                <Download size={14} /> {installing === hit.slug ? 'Installing…' : 'Install'}
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
