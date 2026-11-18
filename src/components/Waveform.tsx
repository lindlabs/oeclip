import { memo, useEffect, useRef, useState } from "react";
import { api } from "../api";

type Peak = { min: number; max: number };

const WAVE_CACHE = new Map<string, Peak[]>();
const WAVE_REQUESTS = new Map<string, Promise<Peak[]>>();
const MAX_CACHED_WAVEFORMS = 200;

function rememberWaveform(key: string, peaks: Peak[]) {
  WAVE_CACHE.delete(key);
  WAVE_CACHE.set(key, peaks);
  if (WAVE_CACHE.size > MAX_CACHED_WAVEFORMS) {
    const oldest = WAVE_CACHE.keys().next().value;
    if (oldest) WAVE_CACHE.delete(oldest);
  }
}

export const Waveform = memo(function Waveform({
  projectId,
  mediaId,
}: {
  projectId: string;
  mediaId: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<Peak[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const key = `${projectId}:${mediaId}`;
    const cached = WAVE_CACHE.get(key);
    if (cached) {
      setPeaks(cached);
      return () => {
        cancelled = true;
      };
    }

    let request = WAVE_REQUESTS.get(key);
    if (!request) {
      request = api.waveform(projectId, mediaId, 720)
        .then((data) => {
          rememberWaveform(key, data.peaks);
          return data.peaks;
        })
        .finally(() => WAVE_REQUESTS.delete(key));
      WAVE_REQUESTS.set(key, request);
    }
    request
      .then((result) => {
        if (!cancelled) setPeaks(result);
      })
      .catch(() => {
        if (!cancelled) setPeaks([]);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, mediaId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (peaks.length === 0) return;
    const step = Math.max(1, Math.floor(peaks.length / width));
    ctx.fillStyle = "rgba(58, 90, 58, 0.52)";
    for (let x = 0; x < width; x += 1) {
      const peak = peaks[Math.min(peaks.length - 1, x * step)];
      if (!peak) continue;
      const top = height / 2 - peak.max * (height / 2) * 0.9;
      const bottom = height / 2 - peak.min * (height / 2) * 0.9;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [peaks]);

  return (
    <canvas
      ref={canvasRef}
      width={900}
      height={36}
      className="clip-wave"
      aria-label={peaks === null ? "Cargando forma de onda" : peaks.length ? "Forma de onda de audio" : "Forma de onda no disponible"}
    />
  );
});
