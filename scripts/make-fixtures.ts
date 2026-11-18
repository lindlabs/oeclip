import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { config } from "../server/config";
import { runFfmpeg } from "../server/media/process";
import { probeMedia } from "../server/media/probe";

/**
 * Genera material real y reproducible con FFmpeg para probar importacion,
 * analisis, edicion y exportacion sin depender de archivos remotos.
 *
 * Uso:
 *   npm run fixtures
 *   npm run fixtures -- --force   (regenera aunque existan)
 */
const outputDir = path.join(config.rootDir, "fixtures");
const force = process.argv.includes("--force");

interface FixtureSpec {
  file: string;
  description: string;
  build: (target: string) => Promise<void>;
}

const fixtures: FixtureSpec[] = [
  {
    file: "camara-a.mp4",
    description: "6 s, 1280x720, 30 fps, testsrc2 + tono de 440 Hz",
    build: async (target) => {
      await runFfmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=1280x720:r=30:d=6",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=6",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "26",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-shortest",
          "-movflags",
          "+faststart",
          target,
        ],
        { timeoutMs: 120_000, durationSeconds: 6 },
      );
    },
  },
  {
    file: "camara-b.mp4",
    description: "6 s, 1280x720, 30 fps, smptebars + tono de 660 Hz",
    build: async (target) => {
      await runFfmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "smptebars=s=1280x720:r=30:d=6",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=660:sample_rate=48000:duration=6",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "26",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-shortest",
          "-movflags",
          "+faststart",
          target,
        ],
        { timeoutMs: 120_000, durationSeconds: 6 },
      );
    },
  },
  {
    file: "voz-con-pausas.m4a",
    description: "8 s de voz sintetica con pausas reales de silencio",
    build: async (target) => {
      await runFfmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "aevalsrc=0.24*sin(2*PI*320*t)*between(mod(t\\,4)\\,0\\,1.2):s=48000:d=8",
          "-ac",
          "1",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          target,
        ],
        { timeoutMs: 60_000, durationSeconds: 8 },
      );
    },
  },
  {
    file: "foto.png",
    description: "Imagen fija 1280x720 generada con gradiente",
    build: async (target) => {
      await runFfmpeg(
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          "gradients=s=1280x720:c0=0x2F4A3A:c1=0xE7EEE5:d=1",
          "-frames:v",
          "1",
          "-update",
          "1",
          target,
        ],
        { timeoutMs: 60_000 },
      );
    },
  },
];

async function main(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  console.log(`Fixtures de NOVACUT AI en ${outputDir}`);
  for (const fixture of fixtures) {
    const target = path.join(outputDir, fixture.file);
    const exists = await fs
      .stat(target)
      .then((stat) => stat.size > 0)
      .catch(() => false);
    if (exists && !force) {
      console.log(`· ${fixture.file} ya existe (usa --force para regenerarlo)`);
      continue;
    }
    console.log(`· generando ${fixture.file}: ${fixture.description}`);
    await fixture.build(target);
    const probe = await probeMedia(target);
    const size = (await fs.stat(target)).size;
    console.log(
      `  listo: ${probe.kind}, ${probe.width ?? "-"}x${probe.height ?? "-"}, ` +
        `${(probe.durationUs / 1_000_000).toFixed(2)} s, ${(size / 1024).toFixed(1)} KiB`,
    );
  }
  console.log("Fixtures listos. Puedes importarlos desde la interfaz o usarlos en pruebas.");
}

main().catch((error) => {
  console.error("No se pudieron generar los fixtures:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
