# Pruebas de carga con k6 — M6 · Grupo 12

Runbook operativo para ejecutar y reproducir las pruebas de carga de **M6 — Viajes y Ciclo de Vida (Grupo 12)** según la especificación cerrada en [PROPUESTA.md](./PROPUESTA.md).

## 1. Requisitos previos

* **Docker** instalado y en ejecución (se utiliza la imagen `grafana/k6:0.54.0`; no requiere instalar k6 localmente).
* **`curl`** disponible en el host para la verificación previa de `GET /health`.
* Servicio M6 levantado con PostgreSQL y:
  * `ENABLE_DEMO_AUTH=true` en el servidor de prueba (**nunca en producción**; volver a `false` al finalizar).
  * `M8_API_URL=""` (vacía, para que el servicio use la simulación de QR en memoria sin depender de M8).

> **Advertencia de seguridad:** si la URL de prueba es pública en Internet, **no usar `ENABLE_DEMO_AUTH=true`**. En ese caso corresponde migrar a Keycloak con usuarios fijos y límites altos, lo cual está fuera del alcance de esta implementación.

## 2. Escenario y modos

Cada iteración ejecuta el ciclo completo de un viaje:

1. `SYSTEM` crea el viaje (`POST /api/v1/trips`, espera `201`) con `Bearer SYSTEM:m5-despacho-N`.
2. `DRIVER` registra arribo (`POST /api/v1/trips/:id/arrived`, espera `200`) con `Bearer DRIVER:<uuid>`.
3. 15% cancela con `CLIENT` (`POST /api/v1/trips/:id/cancel`, motivo `CHANGE_OF_PLANS`, `Bearer CLIENT:<uuid>`, sin lecturas).
4. 85% inicia con `DRIVER` (`POST /api/v1/trips/:id/start`, `verificationToken: "QR-<id>"`) y finaliza (`POST /api/v1/trips/:id/complete`, `distanceKm` entre 2 y 12).
5. 20% de los viajes completados ejecutan lecturas (`GET /api/v1/trips/:id` y `GET /api/v1/trips/:id/history`) con `DRIVER`.

| Modo | VUs | Perfil (rampa / régimen / bajada) | IDs y pool `SYSTEM` | Umbrales |
|---|---|---|---|---|
| `smoke` | 2 | `10s / 20s / 20s` | Nuevos por iteración + pool `ceil(VUs/20)+2` | `http_req_failed < 1%`, `checks > 99%`, `m6_viajes_completados > 0` |
| `serie` | 50, 100, 500, 1000 (secuencial, 30s enfriamiento) | `1m / 3m / 20s` | Nuevos por iteración + pool `ceil(VUs/20)+2` | `http_req_failed < 5%`, `p95 < 1500ms`, `checks > 99%`, `m6_http_429 == 0` |
| `limites` | 500 | `1m / 3m / 20s` | Fijos por VU + único `m5-despacho-1` | `m6_http_5xx == 0`, `p95(expected_response:true) < 1500ms`, `m6_http_429 > 0` |
| `individual` | Configurable (`50`, `100`, `500`, `1000`) | Configurable (default `1m / 3m / 20s`) | Nuevos por iteración + pool `ceil(VUs/20)+2` | Igual que `serie` |

## 3. Ejecución local

### 3.1 Levantar el servicio local para smoke

```bash
# 1. Levantar PostgreSQL
docker compose up -d postgres

# 2. Levantar el backend en modo prueba con demo auth y QR simulado
cd backend
ENABLE_DEMO_AUTH=true M8_API_URL="" npm run dev
```

### 3.2 Correr k6 en local

Desde la raíz del repositorio:

```bash
# Smoke test (2 VUs, 10s rampa / 20s régimen)
./k6/correr-local.sh smoke

# Corrida individual (ej. 100 VUs)
./k6/correr-local.sh individual 100

# Corrida individual con duración personalizada
RAMPA=30s DURACION=1m LECTURAS=20 ./k6/correr-local.sh individual 50

# Corrida de límites (500 VUs alcanzando 429 a propósito)
./k6/correr-local.sh limites

# Serie completa secuencial (50 -> 100 -> 500 -> 1000 VUs, ~23 min)
./k6/correr-local.sh serie
```

> **Windows con Docker Desktop:** si `--network host` no resuelve `localhost` desde el contenedor, pasar `BASE_URL="http://host.docker.internal:3006"`.

### 3.3 Corrida local opcional con límites desactivados (100 VUs)

Esta corrida es únicamente local y preliminar (queda fuera de la evidencia cloud). En G12, `0` **no** desactiva el límite (el código vuelve al default de 120/1200). Por eso se reinicia el servicio local con límites altos:

```bash
ENABLE_DEMO_AUTH=true \
M8_API_URL="" \
RATE_LIMIT_USER_PER_MIN=1000000 \
RATE_LIMIT_SERVICE_PER_MIN=1000000 \
npm run dev
```

Y ejecutar:

```bash
MODO_ETIQUETA=local ./k6/correr-local.sh individual 100
```

## 4. Ejecución en GitHub Actions (cloud)

Workflow: [`.github/workflows/k6.yml`](../.github/workflows/k6.yml). Se dispara únicamente de forma manual mediante **`workflow_dispatch`** desde la pestaña **Actions → M6 Viajes (G12) - Pruebas de carga (k6)**.

### 4.1 Secrets requeridos en el repositorio

| Nombre | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `K6_BASE_URL` | Secret | Sí | URL del servicio de prueba (sin barra final o con ella, se normaliza). |

No se configura ningún secreto de autenticación en GitHub: los tokens demo se construyen en el escenario y `ENABLE_DEMO_AUTH=true` vive únicamente en la configuración del servidor de prueba.

### 4.2 Entradas del workflow

* `modo`: `smoke` | `serie` | `limites` | `individual`
* `vus`: `50` | `100` | `500` | `1000` (solo aplica en `individual`)
* `rampa`: texto, default `1m` (solo aplica en `individual`)
* `duracion`: texto, default `3m` (solo aplica en `individual`)
* `lecturas`: texto, default `20` (porcentaje de lecturas GET)

### 4.3 Protocolo de ejecución en cloud

1. Confirmar que el servidor de prueba tiene `ENABLE_DEMO_AUTH=true` y `M8_API_URL=""` (y que el entorno es privado/restringido).
2. Reiniciar el servicio de prueba antes de iniciar la serie (en G12 esto también limpia contadores de rate limit y QR usados en memoria; no truncar tablas y registrar volumen acumulado en bitácora).
3. Ejecutar primero `modo=smoke` para validar conectividad, demo auth y `/health`.
4. Ejecutar `modo=serie` (un solo job que corre 50, 100, 500 y 1000 VUs con 30s de enfriamiento; ~23 minutos).
5. Al terminar la serie, ejecutar `modo=limites` (500 VUs con IDs fijos por VU).
6. Al finalizar todas las pruebas, volver `ENABLE_DEMO_AUTH=false` en el servidor.
7. Descargar los artifacts `k6-<modo>-<run_id>` para consolidar la tabla comparativa junto con G5.

> **Nota sobre concurrencia:** el workflow define `concurrency` con `cancel-in-progress: false` para impedir que dos corridas se superpongan sobre el mismo servicio.

## 5. Evidencia y resultados

* En local, los archivos se guardan en `k6/resultados/` (ignorado por Git).
* En Actions, se suben siempre (`if: always()`) en el artifact `k6-<modo>-<run_id>`.
* Archivos generados por cada nivel (`testid = g12-<modo>-<vus>vu-<timestamp>`):
  * `resumen-<testid>.json`: percentiles (`avg`, `min`, `med`, `p90`, `p95`, `p99`, `max`), tasas, `dropped_iterations` y contadores propios (`m6_viajes_completados`, `m6_viajes_cancelados`, `m6_ciclos_fallidos`, `m6_http_429`, `m6_http_5xx`, `m6_lecturas`).
  * `salida-<testid>.txt`: salida completa de consola y diagnóstico de CPU del runner.

Plantilla de tabla comparativa:

| Corrida | VUs | p50 | p95 | p99 | req/s | % errores | 429 | 5xx | Viajes completados | Cancelados |
|---|---|---|---|---|---|---|---|---|---|---|
| serie | 50 | | | | | | | | | |
| serie | 100 | | | | | | | | | |
| serie | 500 | | | | | | | | | |
| serie | 1000 | | | | | | | | | |
| limites | 500 | | | | | | | | | |
