export interface Rational {
  num: number;
  den: number;
}

export const SUPPORTED_FPS = [23.976, 24, 25, 30, 50, 59.94, 60] as const;

export function toRational(value: number): Rational {
  if (Math.abs(value - 23.976) < 0.01) return { num: 24000, den: 1001 };
  if (Math.abs(value - 29.97) < 0.01) return { num: 30000, den: 1001 };
  if (Math.abs(value - 59.94) < 0.01) return { num: 60000, den: 1001 };
  if (Number.isInteger(value)) return { num: value, den: 1 };
  const rounded = Math.round(value * 1000);
  return { num: rounded, den: 1000 };
}

export function fpsValue(fps: Rational): number {
  return fps.num / fps.den;
}

export function frameDurationUs(fps: Rational): number {
  return (1_000_000 * fps.den) / fps.num;
}

export function framesToUs(frames: number, fps: Rational): number {
  return Math.round((frames * 1_000_000 * fps.den) / fps.num);
}

export function usToFrames(us: number, fps: Rational): number {
  return Math.round((us * fps.num) / (1_000_000 * fps.den));
}

export function secondsToFrames(seconds: number, fps: Rational): number {
  return Math.round((seconds * fps.num) / fps.den);
}

export function framesToSeconds(frames: number, fps: Rational): number {
  return (frames * fps.den) / fps.num;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatTimecode(frames: number, fps: Rational, withFrames = true): string {
  const safe = Math.max(0, Math.round(frames));
  const fpsNum = fps.num / fps.den;
  const fpsInt = Math.max(1, Math.round(fpsNum));
  const totalSeconds = Math.floor(safe / fpsNum);
  const ff = Math.round(safe % fpsInt);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const base = `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return withFrames ? `${base}:${String(ff).padStart(2, "0")}` : base;
}

export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(clamp(value, 0, 1) * 100)}%`;
}

export function formatDurationUs(us: number): string {
  const total = Math.max(0, Math.round(us / 1_000_000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function newId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${uuid.replace(/-/g, "").slice(0, 16)}`;
}
