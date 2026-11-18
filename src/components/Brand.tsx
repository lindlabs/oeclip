import type { FC } from "react";

/**
 * Emblema oficial de OECLIP: marco de estudio oscuro + anillo óptico "O" + cuña de corte/play "CLIP".
 * Diseñado con trazo nítido para mantenerse legible desde favicon hasta cabecera completa.
 */
export const OeclipMark: FC = () => (
  <svg viewBox="0 0 32 32" width="22" height="22" fill="none" aria-hidden="true">
    <circle cx="11.5" cy="16" r="5.5" stroke="#F7F8F4" strokeWidth="2.6" />
    <rect x="18.6" y="8.8" width="1.8" height="14.4" rx="0.9" fill="#ADC4AE" />
    <path d="M22.2 10.2L28.8 16L22.2 21.8V10.2Z" fill="#2FE271" />
  </svg>
);

export const BrandMarkA = OeclipMark;

export const BRAND_MARKS: Record<string, FC> = {
  A: OeclipMark,
};

type BrandProps = {
  compact?: boolean;
  variant?: keyof typeof BRAND_MARKS;
  showMark?: boolean;
};

/**
 * Identidad unificada de OECLIP: emblema de estudio + logotipo tipográfico equilibrado.
 */
export function Brand({ compact = false, variant = "A", showMark = true }: BrandProps) {
  const Mark = BRAND_MARKS[variant] ?? OeclipMark;
  return (
    <span className="brand">
      {showMark && (
        <span className="brand-mark" aria-hidden="true">
          <Mark />
        </span>
      )}
      {!compact && (
        <span className="brand-word">
          <span className="brand-oe">OE</span>
          <em className="brand-clip">CLIP</em>
        </span>
      )}
    </span>
  );
}

export default Brand;
