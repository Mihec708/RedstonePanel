// Synthesized "redstone block" sounds using the Web Audio API.
// No audio files are bundled — everything is generated on the fly, so it
// works fully offline inside the Tauri app.

let ctx: AudioContext | null = null;

function audio(): AudioContext {
  if (!ctx) {
    const AC =
      (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** A low "thock" (piston-like): a pitched oscillator with a quick pitch drop + fast decay. */
function thock(freq: number, dur: number, peak: number, at = 0) {
  const c = audio();
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.45), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

/** A short filtered-noise "clack" / "tick" (the impact part of a block). */
function clack(dur: number, peak: number, freq: number, at = 0) {
  const c = audio();
  const t = c.currentTime + at;
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  const g = c.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(c.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

type Block = { name: string; play: () => void };

const BLOCKS: Block[] = [
  { name: 'Piston', play: () => { thock(170, 0.12, 0.55); clack(0.05, 0.35, 1400); } },
  { name: 'Piston (retract)', play: () => { thock(120, 0.14, 0.5); clack(0.04, 0.3, 1100, 0.02); } },
  { name: 'Dispenser', play: () => { clack(0.04, 0.4, 2200); thock(210, 0.09, 0.4, 0.06); clack(0.05, 0.28, 900, 0.12); } },
  { name: 'Dropper', play: () => { thock(150, 0.1, 0.5); clack(0.03, 0.22, 1600); } },
  { name: 'Hopper', play: () => { clack(0.03, 0.35, 2600); clack(0.04, 0.26, 1800, 0.07); } },
  { name: 'Redstone click', play: () => { clack(0.03, 0.4, 3200); } },
];

let last = -1;

/** Play a random redstone block sound (piston, dispenser, hopper, …). Returns the block name. */
export function playRandomBlockSound(): string {
  // Avoid the same block twice in a row.
  let idx = Math.floor(Math.random() * BLOCKS.length);
  if (BLOCKS.length > 1 && idx === last) idx = (idx + 1) % BLOCKS.length;
  last = idx;
  const block = BLOCKS[idx];
  block.play();
  return block.name;
}
