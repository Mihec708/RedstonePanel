import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, FolderTree, RefreshCw, Save } from 'lucide-react';
import { useApp } from '../AppContext';
import * as api from '../api';
import type { FileEntry } from '../types';

export function FilesTab() {
  const { selected, setError, setNotice, openFolder } = useApp();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [fileText, setFileText] = useState('');
  const [dirty, setDirty] = useState(false);

  const loadFiles = useCallback(async () => {
    if (!selected) return;
    try {
      setFiles(await api.listFiles(selected.id));
    } catch {
      setFiles([]);
    }
  }, [selected?.id]);

  useEffect(() => {
    setOpenFile(null);
    setFileText('');
    setDirty(false);
    loadFiles();
  }, [loadFiles]);

  if (!selected) {
    return <div className="tab-empty">Select or add a server to manage its files.</div>;
  }

  async function openFileEntry(entry: FileEntry) {
    if (entry.dir) return;
    setError(null);
    try {
      const text = await api.readFile(selected!.id, entry.name);
      setOpenFile(entry.name);
      setFileText(text);
      setDirty(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveFile() {
    if (!openFile) return;
    setError(null);
    try {
      await api.writeFile(selected!.id, openFile, fileText);
      setDirty(false);
      setNotice(`${openFile} saved`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="tab-body files-layout">
      <section className="panel file-browser">
        <header>
          <span className="panel-icon">
            <FolderTree />
          </span>
          <h2>Files</h2>
          <span className="panel-actions">
            <button onClick={loadFiles} title="Refresh file list">
              <RefreshCw size={14} />
            </button>
            <button onClick={() => openFolder(selected.id)} title="Open folder in file manager">
              <FolderOpen size={14} />
            </button>
          </span>
        </header>
        <div className="file-list">
          {files.length === 0 && (
            <span className="toolbar-hint">No files yet — this is the server folder.</span>
          )}
          {files.map((file) => (
            <button
              key={file.name}
              className={openFile === file.name ? 'file-row file-active' : 'file-row'}
              disabled={file.dir}
              onClick={() => openFileEntry(file)}
            >
              <span className={file.dir ? 'file-glyph dir' : 'file-glyph'}>{file.dir ? '▸' : '├'}</span>
              <span className="file-name">{file.name}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="panel editor-pane">
        <header>
          <h2>{openFile ?? 'Editor'}</h2>
          {dirty && <span className="planned-chip">unsaved</span>}
          {openFile && (
            <span className="panel-actions">
              <button className="primary" onClick={saveFile}>
                <Save size={14} /> Save
              </button>
            </span>
          )}
        </header>
        {openFile ? (
          <textarea
            className="editor-area"
            value={fileText}
            spellCheck={false}
            onChange={(event) => {
              setFileText(event.target.value);
              setDirty(true);
            }}
          />
        ) : (
          <div className="editor-empty">
            <FolderTree size={40} />
            <p>
              Click a file on the left (like <code>server.properties</code>) to open it here, then Save.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
