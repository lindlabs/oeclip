import React from "react";
import { Composition, registerRoot } from "remotion";
import { NovacutOverlays, type NovacutOverlaysProps } from "./OverlayComposition";
import { NOVACUT_OVERLAY_COMPOSITION_ID } from "../src/shared/remotionSpec";

/**
 * Raíz de Remotion para la capa de gráficos de NOVACUT. Las dimensiones y
 * duración reales las fija el servidor al llamar a renderFrames; estos valores
 * solo son valores por defecto para que el bundle registre la composición.
 */
registerRoot(() => (
  <Composition<any, NovacutOverlaysProps>
    id={NOVACUT_OVERLAY_COMPOSITION_ID}
    component={NovacutOverlays}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ overlays: [], fonts: [] }}
  />
));
