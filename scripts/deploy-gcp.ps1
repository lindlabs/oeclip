# ==============================================================================
# Script de Despliegue de OECLIP en Google Cloud Run (PowerShell)
# ==============================================================================
param (
    [string]$ProjectId = "gen-lang-client-0787787872",
    [string]$Region = "us-central1",
    [string]$ServiceName = "oeclip",
    [string]$StorageBucket = "oeclip-data-604825376915",
    [string]$Cpu = "4",
    [string]$Memory = "8Gi",
    [int]$MinInstances = 1,
    [int]$TimeoutSeconds = 3600
)

$ErrorActionPreference = "Continue"

function Invoke-GCloud {
    param([string[]]$GCloudArgs)
    & gcloud @GCloudArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Error ejecutando gcloud $($GCloudArgs -join ' ') (código $LASTEXITCODE)"
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "🚀 DESPLIEGUE DE OECLIP EN GOOGLE CLOUD RUN" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Verificar gcloud CLI (incluyendo ruta estándar en LocalAppData si no está en PATH)
if (-not (Get-Command "gcloud" -ErrorAction SilentlyContinue)) {
    $sdkBin = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin"
    if (Test-Path (Join-Path $sdkBin "gcloud.cmd")) {
        $env:PATH = "$sdkBin;$env:PATH"
    } else {
        Write-Error "El comando 'gcloud' no está instalado o no se encuentra en el PATH. Instala Google Cloud SDK: https://cloud.google.com/sdk/docs/install"
        exit 1
    }
}

# 2. Configurar Proyecto
if (-not $ProjectId) {
    $ProjectId = gcloud config get-value project 2>$null
    if (-not $ProjectId -or $ProjectId -eq "(unset)") {
        $ProjectId = Read-Host "Ingresa tu Google Cloud Project ID"
    }
}

if (-not $ProjectId) {
    Write-Error "Se requiere un Project ID válido de Google Cloud."
    exit 1
}

Write-Host "📌 Proyecto GCP: $ProjectId" -ForegroundColor Green
Write-Host "📌 Región: $Region" -ForegroundColor Green
Write-Host "📌 Servicio: $ServiceName" -ForegroundColor Green
Invoke-GCloud @("config", "set", "project", $ProjectId, "--quiet")

# 3. Habilitar APIs necesarias
Write-Host "`n⚙️  Habilitando APIs requeridas (Cloud Run, Cloud Build, Artifact Registry, Storage)..." -ForegroundColor Yellow
Invoke-GCloud @("services", "enable", "run.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "storage.googleapis.com", "--project", $ProjectId)

# 4. Crear bucket persistente si se especificó o si no existe
if (-not $StorageBucket) {
    $StorageBucket = "oeclip-storage-$ProjectId"
}

Write-Host "`n🪣 Verificando bucket de almacenamiento persistente ($StorageBucket)..." -ForegroundColor Yellow
& gcloud storage buckets describe "gs://$StorageBucket" --project $ProjectId 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creando bucket gs://$StorageBucket en $Region..." -ForegroundColor Cyan
    Invoke-GCloud @("storage", "buckets", "create", "gs://$StorageBucket", "--project=$ProjectId", "--location=$Region", "--uniform-bucket-level-access")
}

# 5. Desplegar en Cloud Run
Write-Host "`n📦 Compilando imagen y desplegando en Cloud Run (usando Cloud Build)..." -ForegroundColor Yellow
Write-Host "Asignando $Cpu vCPUs, $Memory RAM, Timeout $TimeoutSeconds seg..." -ForegroundColor Cyan

$deployArgs = @(
    "run", "deploy", $ServiceName,
    "--source", ".",
    "--project", $ProjectId,
    "--region", $Region,
    "--allow-unauthenticated",
    "--quiet",
    "--port", "8080",
    "--cpu", $Cpu,
    "--memory", $Memory,
    "--min-instances", "$MinInstances",
    "--timeout", "$TimeoutSeconds",
    "--execution-environment", "gen2",
    "--add-volume", "name=oeclip-data,type=cloud-storage,bucket=$StorageBucket",
    "--add-volume-mount", "volume=oeclip-data,mount-path=/app/data",
    "--update-env-vars", "NODE_ENV=production,NOVACUT_HOST=0.0.0.0,NOVACUT_ENCODER=cpu"
)

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    Invoke-GCloud $deployArgs
} finally {
    Pop-Location
}

Write-Host "`n✅ ¡DESPLIEGUE COMPLETADO CON ÉXITO!" -ForegroundColor Green
$serviceUrl = & gcloud run services describe $ServiceName --project $ProjectId --region $Region --format "value(status.url)"
if ($LASTEXITCODE -eq 0 -and $serviceUrl) {
    Write-Host "🌐 URL pública del servicio: $serviceUrl" -ForegroundColor Cyan
}

