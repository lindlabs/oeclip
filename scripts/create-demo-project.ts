import process from "node:process";
import { config, ensureBaseDirs } from "../server/config";
import { createDemoProject } from "../server/services/demoService";

/**
 * Crea el proyecto de demostracion usando metraje real generado por FFmpeg.
 * No descarga nada: todo el material queda dentro de data/projects/<id>/media.
 */
async function main(): Promise<void> {
  ensureBaseDirs();
  console.log(`Generando proyecto de demostracion en ${config.dataDir} ...`);
  const started = Date.now();
  const bundle = await createDemoProject();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Proyecto creado: ${bundle.project.name}`);
  console.log(`  id: ${bundle.project.id}`);
  console.log(`  recursos: ${bundle.project.media.length}`);
  console.log(`  pistas: ${bundle.project.tracks.length}`);
  console.log(`  duracion: ${(bundle.project.tracks
    .flatMap((track) => track.clips)
    .reduce((max, clip) => Math.max(max, clip.startFrame + clip.durationFrames), 0) /
    30
  ).toFixed(2)} s`);
  console.log(`  tiempo de generacion: ${seconds} s`);
  console.log(`Abre http://${config.host}:${config.port}/#/p/${bundle.project.id} con el servidor en marcha.`);
}

main().catch((error) => {
  console.error("No se pudo crear el proyecto de demostracion:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
