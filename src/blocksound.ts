// Redstone block sounds for the 15-click logo easter egg.
//
// Two sound sources, in priority order:
// 1. Files dropped into `src/sounds/` (.ogg .mp3 .wav .m4a .flac .webm .aac).
//    They are picked up automatically at build time — a random one plays,
//    and adding new files requires no code changes.
// 2. Synthesized Web Audio fallbacks (below), used when the folder has no
//    sound files, so the easter egg always works.

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

let lastBlock = -1;

/** Play a random synthesized block sound (never the same one twice in a row). Returns its name. */
function playSynth(): string {
  let idx = Math.floor(Math.random() * BLOCKS.length);
  if (BLOCKS.length > 1 && idx === lastBlock) idx = (idx + 1) % BLOCKS.length;
  lastBlock = idx;
  const block = BLOCKS[idx];
  block.play();
  return block.name;
}

// ---- Sound files dropped into src/sounds/ ----
// Vite bundles every matching file and hands us its URL. Adding or removing
// files in that folder requires no changes here.
const FILE_SOUNDS: string[] = Object.values(
  import.meta.glob('./sounds/*.{ogg,mp3,wav,m4a,flac,webm,aac}', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
) as string[];

let lastFile = -1;
let currentAudio: HTMLAudioElement | null = null;

/** Play a random bundled sound file (never the same one twice in a row). */
function playRandomFile(): void {
  let idx = Math.floor(Math.random() * FILE_SOUNDS.length);
  if (FILE_SOUNDS.length > 1 && idx === lastFile) idx = (idx + 1) % FILE_SOUNDS.length;
  lastFile = idx;
  if (currentAudio) currentAudio.pause();
  const el = new Audio(FILE_SOUNDS[idx]);
  currentAudio = el;
  el.volume = 0.9;
  void el.play().catch(() => {
    // File failed to decode/play — fall back to a synthesized sound.
    playSynth();
  });
}

/**
 * Play a random redstone block sound: a file from src/sounds/ if any exist,
 * otherwise a synthesized block sound. Returns the name of the sound used.
 */
export function playRandomBlockSound(): string {
  if (FILE_SOUNDS.length > 0) {
    playRandomFile();
    return 'sound file';
  }
  return playSynth();
}
