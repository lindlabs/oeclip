# ==============================================================================
# OECLIP - Dockerfile de Producción para Despliegue en la Nube
# Soporta: Railway, Render, Fly.io, AWS ECS / App Runner, GCP Cloud Run, VPS
# ==============================================================================

FROM node:22-bookworm-slim AS base

# 1. Instalar dependencias del sistema: FFmpeg, Chromium headless para Remotion y motores TTS (espeak-ng + edge-tts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    espeak-ng \
    python3 \
    python3-pip \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/* \
    && (pip3 install --no-cache-dir --break-system-packages edge-tts || true)

WORKDIR /app

# Configuración de Chromium para Remotion en contenedores Linux
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    REMOTION_CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    NOVACUT_HOST=0.0.0.0 \
    PORT=8080

# 2. Copiar manifiesto de dependencias e instalar
COPY package*.json ./
RUN npm ci --include=dev

# 3. Copiar código fuente
COPY . .

# 4. Compilar interfaz frontend (Vite -> /dist)
RUN npm run build

# 5. Crear directorios de datos persistentes
RUN mkdir -p /app/data /app/data/projects /app/data/tmp /app/data/trash /app/exports

# 6. Exponer puerto HTTP (Cloud Run usa 8080 por defecto)
EXPOSE 8080 4331

# 7. Volumen recomendado para persistencia de proyectos y medios
VOLUME ["/app/data", "/app/exports"]

# 8. Comando de arranque
CMD ["npm", "start"]

