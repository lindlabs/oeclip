import type { Project, TextClip } from "./schema";
import { framesToSeconds, frameDurationUs } from "./time";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function srtTimestamp(frames: number, fps: { num: number; den: number }): string {
  const totalMs = Math.max(0, Math.round((frames * fps.den * 1000) / fps.num));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(ms, 3)}`;
}

export function subtitleClips(project: Project): TextClip[] {
  return project.tracks
    .filter((track) => track.kind === "text" && !track.hidden)
    .flatMap((track) => track.clips)
    .filter((clip): clip is TextClip => clip.type === "text" && (clip.role === "subtitle" || clip.role === "caption"))
    .sort((a, b) => a.startFrame - b.startFrame);
}

export function buildSrt(project: Project): string {
  const clips = subtitleClips(project);
  return clips
    .map((clip, index) => {
      const lines = clip.text.replace(/\r/g, "").trim();
      return `${index + 1}\n${srtTimestamp(clip.startFrame, project.settings.fps)} --> ${srtTimestamp(
        clip.startFrame + clip.durationFrames,
        project.settings.fps,
      )}\n${lines}\n`;
    })
    .join("\n");
}

export function wrapText(text: string, maxChars: number): string {
  const limit = Math.max(8, Math.floor(maxChars));
  const paragraphs = text.replace(/\r/g, "").split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > limit && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

export function clipTimelineSeconds(clip: TextClip, project: Project): { start: number; end: number } {
  return {
    start: framesToSeconds(clip.startFrame, project.settings.fps),
    end: framesToSeconds(clip.startFrame + clip.durationFrames, project.settings.fps),
  };
}

export function projectFrameSeconds(project: Project): number {
  return frameDurationUs(project.settings.fps) / 1_000_000;
}
