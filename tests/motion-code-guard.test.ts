import { describe, expect, it } from "vitest";
import {
  clampDurationFrames,
  sanitizeComponentCode,
  secondsToFrames,
  validateTsx,
} from "../server/motion-agent/code-guard";

describe("guardas de código del motor de motion graphics", () => {
  it("quita fences, imports externos y helpers inventados", () => {
    const result = sanitizeComponentCode(`\`\`\`tsx
import React from "react";
import { motion } from "framer-motion";
import { useCurrentFrame, linear } from "remotion";

export const Pieza = () => {
  const frame = useCurrentFrame();
  return <div style={{ opacity: frame / 10 }} />;
};
\`\`\``);

    expect(result.name).toBe("Pieza");
    expect(result.code).not.toContain("framer-motion");
    expect(result.code).not.toContain("linear");
    expect(result.code).toContain('from "remotion"');
  });

  it("añade los imports de Remotion que el código usa sin declarar", () => {
    const result = sanitizeComponentCode(`
import { useCurrentFrame, useVideoConfig } from "remotion";

export const Mapa = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, 10], [0, 1]) }}>
      <div style={{ transform: \`scale(\${spring({ frame, fps })})\` }}>Lima</div>
    </AbsoluteFill>
  );
};`);

    expect(result.code).toContain("AbsoluteFill");
    expect(result.code).toContain("interpolate");
    expect(result.code).toContain("spring");
  });

  it("valida TSX correcto y rechaza sintaxis rota", async () => {
    const ok = await validateTsx(
      `export const Ok = () => <div style={{ color: "red" }}>Hola</div>;`,
    );
    expect(ok.ok).toBe(true);

    const broken = await validateTsx(`export const Rojo = () => <div>Hola</span>;`);
    expect(broken.ok).toBe(false);
  });

  it("rechaza inputRange no monótono antes de gastar un render", async () => {
    const repeated = await validateTsx(
      `import { interpolate } from "remotion";
export const Beats = () => <div style={{ opacity: interpolate(0, [0, 45, 45, 90], [0, 1, 0, 1]) }} />;`,
    );
    expect(repeated.ok).toBe(false);
    expect(repeated.error).toContain("estrictamente creciente");

    const valid = await validateTsx(
      `import { interpolate } from "remotion";
export const Beats = () => <div style={{ opacity: interpolate(0, [0, 45, 90], [0, 1, 0]) }} />;`,
    );
    expect(valid.ok).toBe(true);
  });

  it("normaliza duraciones y lee segundos del brief", () => {
    expect(secondsToFrames("que dure 4 segundos", 30)).toBe(120);
    expect(secondsToFrames("2,5s", 25)).toBe(63);
    expect(secondsToFrames("sin duración", 30)).toBeNull();
    expect(clampDurationFrames(120, 30)).toBe(120);
    expect(clampDurationFrames(0, 30)).toBe(90);
    expect(clampDurationFrames(99999, 30)).toBe(900);
  });
});
