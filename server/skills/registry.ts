import path from "node:path";
import { SkillRegistry } from "../../src/shared/skills";

/**
 * Registro compartido de skills. Vive en su propio modulo para que tanto las
 * herramientas del agente como las rutas HTTP usen exactamente la misma
 * instancia (y por tanto los mismos datos recargados tras una subida).
 */
export const skillsDir = path.join(process.cwd(), "skills");

export const skillRegistry = new SkillRegistry(skillsDir);

await skillRegistry.loadAll();

export function getSkillsDir(): string {
  return skillsDir;
}
