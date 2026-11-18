#!/usr/bin/env bash
# ==============================================================================
# Script de Despliegue de OECLIP en Google Cloud Run (Bash)
# ==============================================================================
set -euo pipefail

PROJECT_ID="${1:-gen-lang-client-0787787872}"
REGION="${2:-us-central1}"
SERVICE_NAME="${3:-oeclip}"
STORAGE_BUCKET="${4:-oeclip-data-604825376915}"
CPU="${5:-2}"
MEMORY="${6:-4Gi}"
TIMEOUT="${7:-3600}"

echo "=========================================================="
echo "🚀 DESPLIEGUE DE OECLIP EN GOOGLE CLOUD RUN"
echo "=========================================================="

if ! command -v gcloud &> /dev/null; then
    echo "❌ Error: 'gcloud' CLI no está instalado. Consulta: https://cloud.google.com/sdk/docs/install"
    exit 1
fi

if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "(unset)" ]; then
    read -rp "Ingresa tu Google Cloud Project ID: " PROJECT_ID
fi

echo "📌 Proyecto GCP: $PROJECT_ID"
echo "📌 Región: $REGION"
echo "📌 Servicio: $SERVICE_NAME"

gcloud config set project "$PROJECT_ID"

echo -e "\n⚙️  Habilitando APIs requeridas..."
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com storage.googleapis.com

if [ -z "$STORAGE_BUCKET" ]; then
  STORAGE_BUCKET="oeclip-storage-${PROJECT_ID}"
fi
echo -e "\n🪣 Verificando bucket de almacenamiento persistente (${STORAGE_BUCKET})..."
if ! gcloud storage buckets describe "gs://${STORAGE_BUCKET}" &>/dev/null; then
    echo "Creando bucket gs://${STORAGE_BUCKET} en ${REGION}..."
    gcloud storage buckets create "gs://${STORAGE_BUCKET}" --location="${REGION}" --uniform-bucket-level-access
fi

echo -e "\n📦 Compilando y desplegando en Google Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu "$CPU" \
  --memory "$MEMORY" \
  --timeout "$TIMEOUT" \
  --execution-environment gen2 \
  --add-volume "name=oeclip-data,type=cloud-storage,bucket=${STORAGE_BUCKET}" \
  --add-volume-mount "volume=oeclip-data,mount-path=/app/data" \
  --update-env-vars "NODE_ENV=production,NOVACUT_HOST=0.0.0.0,NOVACUT_ENCODER=cpu"

echo -e "\n✅ ¡Despliegue completado con éxito!"
echo "URL del servicio:"
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format "value(status.url)"

