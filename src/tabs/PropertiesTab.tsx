import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Save, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../AppContext';
import * as api from '../api';
import { renderMcText, stripMcText } from '../mcformat';

type Entry =
  | { type: 'raw'; text: string }
  | { type: 'pair'; key: string; value: string };

function parseProperties(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      entries.push({ type: 'raw', text: line });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      entries.push({ type: 'raw', text: line });
      continue;
    }
    entries.push({ type: 'pair', key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return entries;
}

function rebuildProperties(entries: Entry[]): string {
  return entries
    .map((entry) => (entry.type === 'raw' ? entry.text : `${entry.key}=${entry.value}`))
    .join('\n');
}

const PALETTE: Array<[string, string]> = [
  ['§0', '#3f3f3f'], ['§1', '#bf3f3f'], ['§2', '#3fbf3f'], ['§3', '#3fbfbf'],
  ['§4', '#3f3fbf'], ['§5', '#bf3fbf'], ['§6', '#bfbf3f'], ['§7', '#bfbfbf'],
  ['§8', '#7f7f7f'], ['§9', '#bf5f5f'], ['§a', '#5fbf5f'], ['§b', '#5fbfbf'],
  ['§c', '#bf5fbf'], ['§d', '#bf5fbf'], ['§e', '#bfbf5f'], ['§f', '#ffffff'],
];
const STYLE_CODES = ['§l', '§o', '§m', '§n', '§r'];

function MotdEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  function insert(code: string) {
    const el = inputRef.current;
    if (!el) {
      onChange(value + code);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + code + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + code.length;
    });
  }

  return (
    <div className="motd-editor">
      <input
        ref={inputRef}
        className="motd-input"
        value={value}
        placeholder="Your server MOTD — use the color codes below"
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="motd-palette">
        {PALETTE.map(([code, color]) => (
          <button
            key={code}
            type="button"
            className="motd-code"
            title={`${code} color`}
            style={{ background: color }}
            onClick={() => insert(code)}
          />
        ))}
        {STYLE_CODES.map((code) => (
          <button
            key={code}
            type="button"
            className="motd-code motd-style"
            title={code === '§l' ? 'Bold' : code === '§o' ? 'Italic' : code === '§m' ? 'Underline' : code === '§n' ? 'Strikethrough' : 'Reset'}
            onClick={() => insert(code)}
          >
            {code === '§l' ? 'B' : code === '§o' ? 'I' : code === '§m' ? 'U' : code === '§n' ? 'S' : 'R'}
          </button>
        ))}
      </div>
      <div className="motd-preview">
        {stripMcText(value) ? (
          <span>{renderMcText(value)}</span>
        ) : (
          <span className="console-empty">MOTD preview</span>
        )}
      </div>
    </div>
  );
}

export function PropertiesTab() {
  const { selected, setError, setNotice, setMotd } = useApp();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const text = await api.readFile(selected.id, 'server.properties');
      setEntries(parseProperties(text));
    } catch (e) {
      setEntries(null);
      setError(`Could not read server.properties: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [selected?.id]);

  useEffect(() => {
    setEntries(null);
    load();
  }, [load]);

  if (!selected) {
    return <div className="tab-empty">Select or add a server to edit its properties.</div>;
  }

  function setValue(index: number, value: string) {
    setEntries((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      const entry = next[index];
      if (entry.type === 'pair') next[index] = { ...entry, value };
      return next;
    });
  }

  async function save() {
    if (!entries) return;
    setError(null);
    try {
      const text = rebuildProperties(entries);
      await api.writeFile(selected!.id, 'server.properties', text);
      const motdEntry = entries.find((e) => e.type === 'pair' && e.key.toLowerCase() === 'motd');
      if (motdEntry && motdEntry.type === 'pair') setMotd(motdEntry.value.trim());
      setNotice('server.properties saved');
    } catch (e) {
      setError(String(e));
    }
  }

  if (loading) return <div className="tab-body"><div className="banner notice-banner">Loading properties…</div></div>;
  if (!entries) {
    return (
      <div className="tab-body">
        <div className="banner error-banner">
          No server.properties found yet — start the server once (it generates the file) or create it from the
          Files tab, then come back.
        </div>
        <button onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div className="tab-body">
      <section className="panel">
        <header>
          <span className="panel-icon">
            <SlidersHorizontal />
          </span>
          <h2>server.properties</h2>
          <span className="panel-actions">
            <button className="primary" onClick={save}>
              <Save size={14} /> Save all
            </button>
          </span>
        </header>
        <p className="toolbar-hint">
          Every line of the properties file as its own control — toggles for on/off, boxes for values. Restart
          the server after saving for changes to take effect.
        </p>
        <div className="prop-list">
          {entries.map((entry, index) => {
            if (entry.type === 'raw') {
              return (
                <div className="prop-module raw" key={index}>
                  <span className="prop-key">#</span>
                  <span className="prop-value raw-text">{entry.text.trim() || '\u00a0'}</span>
                </div>
              );
            }
            const key = entry.key;
            const lower = key.toLowerCase();
            if (lower === 'motd') {
              return (
                <div className="prop-module motd-module" key={index}>
                  <span className="prop-key">MOTD</span>
                  <MotdEditor value={entry.value} onChange={(v) => setValue(index, v)} />
                </div>
              );
            }
            const isBool = entry.value === 'true' || entry.value === 'false';
            const isInt = /^-?\d+$/.test(entry.value.trim());
            return (
              <div className="prop-module" key={index}>
                <span className="prop-key" title={key}>
                  {key}
                </span>
                {isBool ? (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={entry.value === 'true'}
                    title={key}
                    className={`ios-switch ${entry.value === 'true' ? 'on' : ''}`}
                    onClick={() => setValue(index, entry.value === 'true' ? 'false' : 'true')}
                  >
                    <span className="ios-knob" />
                  </button>
                ) : isInt ? (
                  <input
                    type="number"
                    className="prop-input"
                    value={entry.value}
                    onChange={(event) => setValue(index, event.target.value)}
                  />
                ) : (
                  <input
                    className="prop-input"
                    value={entry.value}
                    onChange={(event) => setValue(index, event.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
