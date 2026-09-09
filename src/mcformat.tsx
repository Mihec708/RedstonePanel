import React from 'react';

const COLORS: Record<string, string> = {
  '0': '#3f3f3f', '1': '#bf3f3f', '2': '#3fbf3f', '3': '#3fbfbf',
  '4': '#3f3fbf', '5': '#bf3fbf', '6': '#bfbf3f', '7': '#bfbfbf',
  '8': '#7f7f7f', '9': '#bf5f5f', 'a': '#5fbf5f', 'b': '#5fbfbf',
  'c': '#bf5fbf', 'd': '#bf5fbf', 'e': '#bfbf5f', 'f': '#ffffff',
};

/** Render Minecraft §-formatted text as colored React nodes. */
export function renderMcText(text: string): React.ReactNode {
  const parts = text.split(/(§[0-9a-fk-or])/i);
  const nodes: React.ReactNode[] = [];
  let bold = false;
  let italic = false;
  let underline = false;
  let strike = false;
  let color: string | null = null;
  parts.forEach((part, i) => {
    if (/^§[0-9a-f]$/i.test(part)) {
      color = COLORS[part[1].toLowerCase()] ?? null;
      return;
    }
    if (/^§k$/i.test(part)) return; // obfuscated: skip
    if (/^§l$/i.test(part)) { bold = true; return; }
    if (/^§o$/i.test(part)) { italic = true; return; }
    if (/^§n$/i.test(part)) { strike = true; return; }
    if (/^§m$/i.test(part)) { underline = true; return; }
    if (/^§r$/i.test(part)) { bold = italic = underline = strike = false; color = null; return; }
    if (part.length === 0) return;
    const style: React.CSSProperties = {};
    if (color) style.color = color;
    if (bold) style.fontWeight = 700;
    if (italic) style.fontStyle = 'italic';
    if (strike) style.textDecoration = 'line-through';
    if (underline) style.textDecoration = 'underline';
    nodes.push(
      style.color || style.fontWeight || style.fontStyle || style.textDecoration
        ? <span key={i} style={style}>{part}</span>
        : part,
    );
  });
  return nodes.length > 0 ? nodes : text;
}

/** Strip §-codes, returning plain text. */
export function stripMcText(text: string): string {
  return text.replace(/§[0-9a-fk-or]/gi, '');
}

/** Sparkline helper shared by stats views. */
export function Sparkline({ values, tone }: { values: number[]; tone: 'red' | 'gold' | 'green' }) {
  const safe = values.length > 1 ? values : [0, 0];
  const points = safe
    .map((value, index) => `${(index / (safe.length - 1)) * 100},${42 - Math.max(0, Math.min(100, value)) * 0.38}`)
    .join(' ');
  return (
    <svg className={`sparkline ${tone}`} viewBox="0 0 100 44" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatUptime(secs: number): string {
  if (!secs || secs <= 0) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
