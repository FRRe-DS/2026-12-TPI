#!/usr/bin/env bash
# Ejecuta las pruebas de carga de k6 contra M6 (Grupo 12) en entorno local usando Docker.
# Especificación cerrada en k6/PROPUESTA.md.
#
# Requisitos del servidor local:
#   - ENABLE_DEMO_AUTH=true (solo en entorno de prueba local, nunca en producción).
#   - M8_API_URL vacía (simulación de QR en memoria).
#   - PostgreSQL en ejecución.
#
# Uso:
#   ./k6/correr-local.sh <smoke|serie|limites|individual> [vus]
#
# Variables de entorno:
#   BASE_URL        (opcional) Default: http://localhost:3006
#                              En Windows con Docker Desktop usar http://host.docker.internal:3006
#   VUS             (opcional) Solo para modo individual si no se pasa como 2° argumento (default: 50).
#   RAMPA           (opcional) Solo para modo individual (default: 1m).
#   DURACION        (opcional) Solo para modo individual (default: 3m).
#   LECTURAS        (opcional) Porcentaje de lecturas GET sobre viajes completados (default: 20).
#   MODO_ETIQUETA   (opcional) Permite etiquetar la corrida local con límites altos como "local".
set -euo pipefail

IMAGEN_K6="grafana/k6:0.54.0"
AQUI="$(cd "$(dirname "$0")" && pwd)"
RESULTADOS_DIR="$AQUI/resultados"

uso() {
  cat <<'EOF'
Uso:
  ./k6/correr-local.sh <modo> [vus]

Modos:
  smoke               2 VUs, rampa 10s, régimen 20s, bajada 20s.
  serie               50, 100, 500 y 1000 VUs secuenciales con 30s de enfriamiento.
  limites             500 VUs con IDs fijos por VU y un solo SYSTEM (alcanza 429).
  individual [vus]    Corrida puntual (default: VUS=50, RAMPA=1m, DURACION=3m).

Ejemplos:
  ./k6/correr-local.sh smoke
  ./k6/correr-local.sh individual 100
  MODO_ETIQUETA=local ./k6/correr-local.sh individual 100
  ./k6/correr-local.sh limites
  ./k6/correr-local.sh serie
EOF
}

MODO="${1:-}"
VUS_ARG="${2:-}"

case "$MODO" in
  smoke|serie|limites|individual) ;;
  -h|--help|"")
    uso
    exit 0
    ;;
  *)
    echo "Error: modo inválido '$MODO'. Valores permitidos: smoke, serie, limites, individual." >&2
    uso >&2
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: Docker no está instalado o no está en el PATH." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl no está instalado o no está en el PATH (necesario para verificar /health)." >&2
  exit 1
fi

BASE_URL="${BASE_URL:-http://localhost:3006}"
BASE_URL="${BASE_URL%/}"
LECTURAS="${LECTURAS:-20}"

echo ">> Verificando salud del servicio en ${BASE_URL}/health ..."
if ! curl -fsS --max-time 5 "${BASE_URL}/health" >/dev/null; then
  cat >&2 <<EOF

Error: el servicio M6 (Grupo 12) no respondió en ${BASE_URL}/health.

Para levantarlo localmente con PostgreSQL y demo auth:
  docker compose up -d postgres
  cd backend
  ENABLE_DEMO_AUTH=true M8_API_URL="" npm run dev

Si corrés en Windows con Docker Desktop y localhost no resuelve desde el contenedor, usá:
  BASE_URL="http://host.docker.internal:3006" ./k6/correr-local.sh ${MODO}
EOF
  exit 1
fi
echo ">> Servicio saludable (recordá tener ENABLE_DEMO_AUTH=true y M8_API_URL=\"\" en el servidor)."

mkdir -p "$RESULTADOS_DIR"

ejecutar_corrida() {
  local modo_k6="$1"
  local vus="$2"
  local rampa="$3"
  local duracion="$4"
  local etiqueta_modo="${5:-$modo_k6}"

  local timestamp
  timestamp="$(date -u +%Y%m%d-%H%M%S)"
  local test_id="g12-${etiqueta_modo}-${vus}vu-${timestamp}"
  local json_rel="resumen-${test_id}.json"
  local log_abs="${RESULTADOS_DIR}/salida-${test_id}.txt"

  echo "========================================================================"
  echo ">> k6 G12 | modo=${modo_k6} | vus=${vus} | rampa=${rampa} | regimen=${duracion} | lecturas=${LECTURAS}%"
  echo ">> BASE_URL=${BASE_URL} | testid=${test_id}"
  echo "========================================================================"

  local rc=0
  docker run --rm --network host --user "$(id -u):$(id -g)" \
    -v "${AQUI}/escenarios:/escenarios:ro" \
    -v "${RESULTADOS_DIR}:/resultados" \
    -e "BASE_URL=${BASE_URL}" \
    -e "MODO=${modo_k6}" \
    -e "VUS=${vus}" \
    -e "RAMPA=${rampa}" \
    -e "DURACION=${duracion}" \
    -e "BAJADA=20s" \
    -e "LECTURAS=${LECTURAS}" \
    -e "TEST_ID=${test_id}" \
    "${IMAGEN_K6}" run \
      --tag "testid=${test_id}" \
      --tag "grupo=12" \
      --tag "vus=${vus}" \
      --tag "modo=${etiqueta_modo}" \
      --summary-export="/resultados/${json_rel}" \
      /escenarios/ciclo-de-viaje.js 2>&1 | tee "$log_abs" || rc=$?

  echo ">> Resumen JSON : k6/resultados/${json_rel}"
  echo ">> Log consola  : k6/resultados/salida-${test_id}.txt"
  return "$rc"
}

case "$MODO" in
  smoke)
    ejecutar_corrida "smoke" 2 "10s" "20s" "smoke"
    ;;
  limites)
    ejecutar_corrida "limites" 500 "1m" "3m" "limites"
    ;;
  individual)
    VUS_EFECTIVO="${VUS_ARG:-${VUS:-50}}"
    RAMPA_EFECTIVA="${RAMPA:-1m}"
    DURACION_EFECTIVA="${DURACION:-3m}"
    ETIQUETA="${MODO_ETIQUETA:-individual}"
    MODO_SCRIPT="individual"
    if [ "$ETIQUETA" = "local" ]; then
      MODO_SCRIPT="local"
    fi
    ejecutar_corrida "$MODO_SCRIPT" "$VUS_EFECTIVO" "$RAMPA_EFECTIVA" "$DURACION_EFECTIVA" "$ETIQUETA"
    ;;
  serie)
    NIVELES=(50 100 500 1000)
    FALLO_SERIE=0
    for idx in "${!NIVELES[@]}"; do
      vus="${NIVELES[$idx]}"
      rc=0
      ejecutar_corrida "serie" "$vus" "1m" "3m" "serie" || rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "!! Nivel ${vus} VUs finalizó con código ${rc}." >&2
        FALLO_SERIE="$rc"
      fi
      if [ "$idx" -lt $((${#NIVELES[@]} - 1)) ]; then
        echo ">> Enfriamiento de 30s antes del siguiente nivel..."
        sleep 30
      fi
    done
    exit "$FALLO_SERIE"
    ;;
esac
