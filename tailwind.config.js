/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        slate: {
          50: "#f4f5ef",
          100: "#eceee5",
          200: "#e1e6db",
          300: "#cdd7c6",
          400: "#9aa99a",
          500: "#758077",
          600: "#667168",
          700: "#4b584e",
          800: "#283a28",
          900: "#202a22",
        },
        emerald: {
          50: "#f2f6ef",
          100: "#e7eee2",
          200: "#cfdcc5",
          300: "#b7caaa",
          400: "#9ab38b",
          500: "#7c9a6e",
          600: "#5f7f58",
          700: "#4a6745",
          800: "#384f36",
          900: "#283a28",
        },
        // Colores estilo LearnHub (verde brillante, negro grueso, crema)
        learn: {
          green: "#4ade80",
          "green-dark": "#22c55e",
          cream: "#fdfaf2",
          "cream-dark": "#f4f1ea",
          ink: "#1f2937",
          "ink-soft": "#4b5563",
        },
        // Tinta del proyecto (igual que --ink) para bordes y sombras duras
        ink: {
          DEFAULT: "#202a28",
          soft: "#4b584e",
        },
      },
      fontFamily: {
        // Fuentes de LearnHub: DM Sans para texto, Space Grotesk para títulos
        sans: ["DM Sans", "Inter", "Segoe UI", "system-ui", "sans-serif"],
        display: ["Space Grotesk", "DM Sans", "Inter", "sans-serif"],
        serif: ["Playfair Display", "Georgia", "serif"],
      },
      boxShadow: {
        card: "0 20px 40px -12px rgba(32, 42, 34, 0.08)",
        "card-hover": "0 24px 48px -14px rgba(32, 42, 34, 0.12)",
        "card-dark": "0 20px 40px -12px rgba(0, 0, 0, 0.3)",
        "card-hover-dark": "0 24px 48px -14px rgba(0, 0, 0, 0.4)",
        // Sombra negra gruesa estilo LearnHub
        "learn-card": "0 24px 48px -8px rgba(0, 0, 0, 0.12)",
        "learn-card-dark": "0 24px 48px -8px rgba(0, 0, 0, 0.45)",
        "learn-topbar": "0 12px 24px -4px rgba(0, 0, 0, 0.08)",
      },
      borderRadius: {
        xl: "28px",
        "2xl": "40px",
        "3xl": "52px",
      },
      spacing: {
        "18": "4.5rem",
      },
    },
  },
  plugins: [],
};
