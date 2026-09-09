import React, { useEffect, useRef, useState } from 'react';
import { CirclePower, Play, RefreshCw, Square, TerminalSquare } from 'lucide-react';
import { useApp } from '../AppContext';
import { renderMcText, stripMcText } from '../mcformat';
import { KIND_LABEL } from '../types';

export function MainTab() {
  const { selected, busy, power, sendCommand, selectedLines, stats, motd: motdText } = useApp();
  const [command, setCommand] = useState('');
  const consoleRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selectedLines.length, selected?.id]);

  if (!selected) {
    return <div className="tab-empty">Select or add a server to get started.</div>;
  }

  async function submit() {
    const line = command.trim();
    if (!line) return;
    setCommand('');
    await sendCommand(line);
  }

  return (
    <div className="tab-body">
      <section className="main-hero">
        <div className="main-hero-left">
          <div className="main-hero-title">
            <h2>{selected.name}</h2>
            <span className="status-chip" data-state={selected.running ? 'on' : 'off'}>
              {selected.running ? 'ONLINE' : 'OFFLINE'}
            </span>
            {KIND_LABEL[selected.kind] && selected.version && (
              <span className="main-hero-meta">
                {KIND_LABEL[selected.kind]} {selected.version} · {selected.ram_gb} GB
              </span>
            )}
          </div>
          <div className="motd-strip">
            {stripMcText(motdText) ? (
              <span className="motd-text">{renderMcText(motdText)}</span>
            ) : (
              <span className="console-empty">No MOTD set — add one in the Properties tab.</span>
            )}
          </div>
          <div className="main-hero-stats">
            <span>{selected.running ? 'Running' : 'Stopped'}</span>
            {stats && (
              <>
                <span>{stats.cpu.toFixed(0)}% CPU</span>
                <span>
                  {(stats.ram_used / 2 ** 30).toFixed(1)} / {(stats.ram_alloc / 2 ** 30).toFixed(1)} GB RAM
                </span>
              </>
            )}
          </div>
        </div>
        <div className="power-actions">
          <button disabled={busy || selected.running} onClick={() => power('start')}>
            <Play size={16} /> Start
          </button>
          <button disabled={busy || !selected.running} onClick={() => power('stop')}>
            <Square size={16} /> Stop
          </button>
          <button disabled={busy} onClick={() => power('restart')}>
            <RefreshCw size={16} /> Restart
          </button>
          <button className="danger" disabled={busy || !selected.running} onClick={() => power('kill')}>
            <CirclePower size={16} /> Force Kill
          </button>
        </div>
      </section>

      <section className="panel console-panel">
        <header>
          <span className="panel-icon">
            <TerminalSquare />
          </span>
          <h2>Live Console</h2>
          <span className="planned-chip live">LIVE</span>
        </header>
        <pre className="console" ref={consoleRef}>
          {selectedLines.length === 0 ? (
            <span className="console-empty">
              {selected.running ? 'Waiting for output…' : 'Server is stopped. Press Start to begin.'}
            </span>
          ) : (
            selectedLines.map((line, index) => (
              <React.Fragment key={index}>
                {renderMcText(line.line)}
                {'\n'}
              </React.Fragment>
            ))
          )}
        </pre>
        <div className="command-bar">
          <input
            value={command}
            placeholder="say Welcome to RedstonePanel"
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
          />
          <button disabled={!command.trim()} onClick={submit}>
            Send
          </button>
        </div>
      </section>
    </div>
  );
}
