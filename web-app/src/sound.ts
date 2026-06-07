// Soft, synthesised move feedback (no audio files). Tones are gentle and low to fit
// the calm aesthetic. Muting is remembered across visits.

const MUTE_KEY = "chronael.muted";

let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === "1";
} catch {
  /* private mode */
}

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, durationMs: number, type: OscillatorType, peakGain: number): void {
  const a = audio();
  if (!a) return;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const now = a.currentTime;
  const end = now + durationMs / 1000;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(a.destination);
  osc.start(now);
  osc.stop(end + 0.02);
}

export function playMove(): void {
  tone(330, 90, "triangle", 0.05);
}

export function playCapture(): void {
  // a softer, lower two-part thud
  tone(196, 130, "sine", 0.07);
  window.setTimeout(() => tone(147, 90, "sine", 0.045), 45);
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
