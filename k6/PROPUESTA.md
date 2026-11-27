# Propuesta de pruebas de carga con k6 — M6 · Grupo 12

**Estado:** propuesta para revisión. No incluye código.
**Implementación:** @n1krov 🐔
**Módulo:** M6 — Viajes y Ciclo de Vida.
**Repositorio:** `FRRe-DS/2026-12-TPI`, rama base `m6/base-de-datos`.
**Escenario base de referencia:** [`opsboard-tpi-devops/k6/escenarios/ciclo-de-viaje.js`](https://github.com/universoparalelo/opsboard-tpi-devops/blob/main/k6/escenarios/ciclo-de-viaje.js).

---

## 1. Objetivo

Medir el comportamiento de M6 bajo 50, 100, 500 y 1000 usuarios virtuales con un flujo real de viaje, y comparar qué ocurre cuando se alcanza el límite de pedidos y cuando no se alcanza.

La propuesta deja cerradas todas las decisiones para que la implementación sea mecánica. No modifica código de la aplicación, no despliega y no cambia el contrato.

## 2. Decisiones cerradas

| Tema | Decisión |
|---|---|
| Herramienta | Grafana k6 `0.54.0`, ejecutado con la imagen Docker `grafana/k6:0.54.0`. |
| Escenario | Ciclo completo: crear, arribar, iniciar, finalizar o cancelar. |
| Cancelación | 15% de las iteraciones cancelan con el cliente después del arribo, motivo `CHANGE_OF_PLANS`. |
| Lecturas | 20% de las iteraciones completadas hacen `GET /api/v1/trips/:id` y `GET /api/v1/trips/:id/history` con el token del conductor. |
| Perfil | Rampa `1m`, régimen `3m`, bajada `20s`. |
| Serie principal | 50, 100, 500 y 1000 VUs, secuencial, sin alcanzar los límites. |
| Comparación de límites | Una corrida extra de 500 VUs alcanzando los límites a propósito. |
| Límites desactivados | Solo local, opcional, a 100 VUs. Fuera de la evidencia cloud. |
| Runner | GitHub Actions `ubuntu-latest`. |
| Evidencia | Resumen JSON y log de consola como artifact. Sin Prometheus activo. Sin copia a opsboard. |
| Datos | Reiniciar el servicio antes de cada serie. No truncar tablas. |
| Umbrales | Por modo, detallados en la sección 6. |
| Código de app | Cero cambios. |

## 3. Flujo funcional

Cada iteración representa un viaje completo. Los roles son los del contrato: `SYSTEM` simula a M5, `DRIVER` al conductor y `CLIENT` al cliente.

### 3.1 Pasos

1. `SYSTEM` crea el viaje con `POST /api/v1/trips`. Se guarda el `id` y se usan `clientId` y `driverId` coherentes con los tokens.
2. `DRIVER` registra el arribo con `POST /api/v1/trips/:id/arrived`.
3. Con probabilidad 15%, `CLIENT` cancela con `POST /api/v1/trips/:id/cancel` y motivo `CHANGE_OF_PLANS`. La iteración termina.
4. En el 85% restante, `DRIVER` inicia con `POST /api/v1/trips/:id/start` y `verificationToken` igual a `QR-<id>`.
5. `DRIVER` finaliza con `POST /api/v1/trips/:id/complete` y `distanceKm` aleatorio entre 2 y 12.
6. En 20% de las iteraciones completadas, `DRIVER` consulta `GET /api/v1/trips/:id` y `GET /api/v1/trips/:id/history`.

Los viajes cancelados no ejecutan lecturas. Las lecturas se hacen después de completar para que el estado sea estable.

### 3.2 Requests

| Método | Ruta | Rol | Cuerpo | Éxito |
|---|---|---|---|---|
| POST | `/api/v1/trips` | SYSTEM | `requestId`, `clientId`, `driverId`, `vehicleId`, `vehicleType`, coordenadas de origen y destino | 201 |
| POST | `/api/v1/trips/:id/arrived` | DRIVER | vacío | 200 |
| POST | `/api/v1/trips/:id/start` | DRIVER | `verificationToken: QR-<id>` | 200 |
| POST | `/api/v1/trips/:id/complete` | DRIVER | `distanceKm` entre 2 y 12 | 200 |
| POST | `/api/v1/trips/:id/cancel` | CLIENT | `reason: CHANGE_OF_PLANS` | 200 |
| GET | `/api/v1/trips/:id` | DRIVER | — | 200 |
| GET | `/api/v1/trips/:id/history` | DRIVER | — | 200 |

Datos fijos:

- `vehicleType`: 70% `AUTO`, 30% `MOTO`.
- Origen: latitud `-27.4511`, longitud `-58.9867`.
- Destino: latitud `-27.4698`, longitud `-58.8306`.
- `requestId`, `vehicleId` y los ids de usuario son UUID.
- Esperas: 0,2 a 0,5 s después de crear; 0,2 a 0,3 s después del arribo; 0,3 a 0,8 s después del inicio.

### 3.3 Tokens

G12 valida JWT RS256 de Keycloak, pero para la prueba de carga usa los atajos de demostración habilitados con `ENABLE_DEMO_AUTH=true`.

| Rol | Token | Uso |
|---|---|---|
| SYSTEM | `Bearer SYSTEM:m5-despacho-N` | Crear viajes. |
| DRIVER | `Bearer DRIVER:<uuid>` | Arribo, inicio, fin y lecturas. |
| CLIENT | `Bearer CLIENT:<uuid>` | Cancelación. |

El `sub` del token rápido es el id que sigue al dos puntos. Por eso un `DRIVER:<uuid>` nuevo por iteración evita el límite de 120 pedidos por minuto.

`ENABLE_DEMO_AUTH=true` es una variable del servidor, no un secreto de k6. Debe quedar habilitada solo en el entorno de prueba y volver a `false` al terminar. Si la URL de prueba es pública, no se debe usar demo auth: en ese caso hay que pasar a Keycloak con usuarios fijos y límites altos, lo que queda fuera de esta propuesta.

### 3.4 Tags y métricas

Cada request lleva un tag `name` con la ruta normalizada, por ejemplo `POST /api/v1/trips/:id/arrived`, para no crear una serie por viaje. Cada corrida lleva `testid`, `grupo=12`, `vus` y `modo`.

Contadores propios:

- `m6_viajes_completados`
- `m6_viajes_cancelados`
- `m6_ciclos_fallidos`
- `m6_http_429`
- `m6_http_5xx`
- `m6_lecturas`

## 4. Límites de pedidos

G12 aplica 120 pedidos por minuto por usuario y 1200 por minuto para `SYSTEM`. La configuración se mantiene sin cambios en la serie principal.

### 4.1 Serie principal, sin alcanzar límites

- Cada iteración usa `clientId` y `driverId` nuevos.
- Los tokens `SYSTEM` se reparten en un pool de `ceil(VUs / 20) + 2` identidades `m5-despacho-1..N`.
- No se esperan `429`.

### 4.2 Corrida de comparación, alcanzando límites

- Cada VU usa un `clientId` y un `driverId` fijos, generados al inicio de la corrida y reutilizados en todas sus iteraciones.
- Todos los VUs comparten un único token `SYSTEM` (`m5-despacho-1`).
- Se esperan `429` por límite de usuario y por límite de servicio.
- Los `429` son parte del resultado y no hacen fallar la corrida.

### 4.3 Límites desactivados, solo local

Se ejecuta a 100 VUs contra el servicio local, no contra cloud. No requiere redeploy: se reinicia el servicio local con `RATE_LIMIT_USER_PER_MIN=1000000` y `RATE_LIMIT_SERVICE_PER_MIN=1000000`.

En G12, `0` no desactiva el límite: el código lo interpreta como valor inválido y vuelve al default. Por eso se usa un número alto. Esta corrida queda fuera de la tabla comparativa cloud y se marca como preliminar.

## 5. Matriz de corridas

| # | Modo | VUs | Rampa | Régimen | Bajada | IDs | Límites |
|---|---|---|---|---|---|---|---|
| 1 | serie | 50 | 1m | 3m | 20s | nuevos por iteración | no se alcanzan |
| 2 | serie | 100 | 1m | 3m | 20s | nuevos por iteración | no se alcanzan |
| 3 | serie | 500 | 1m | 3m | 20s | nuevos por iteración | no se alcanzan |
| 4 | serie | 1000 | 1m | 3m | 20s | nuevos por iteración | no se alcanzan |
| 5 | limites | 500 | 1m | 3m | 20s | fijos por VU | se alcanzan |
| L | local | 100 | 1m | 3m | 20s | nuevos por iteración | desactivados |

Reglas:

- Los niveles de la serie son secuenciales, con 30 s de enfriamiento entre uno y otro.
- Nunca se ejecutan dos niveles en paralelo.
- G5 y G12 se lanzan en paralelo, cada uno desde su repositorio, para reducir el tiempo total.
- La corrida 5 se ejecuta después de la serie.
- Tiempo estimado por grupo: 23 minutos. Tiempo de pared con ambos grupos en paralelo: 25 minutos.

## 6. Umbrales

| Modo | Umbrales |
|---|---|
| smoke | `http_req_failed < 1%`, `checks > 99%`, `m6_viajes_completados > 0` |
| serie | `http_req_failed < 5%`, `http_req_duration p95 < 1500 ms`, `checks > 99%`, `m6_http_429 = 0` |
| limites | `m6_http_5xx = 0`, `http_req_duration{expected_response:true} p95 < 1500 ms`, `m6_http_429 > 0`. No se evalúa `http_req_failed` ni `checks`. |
| local con límites desactivados | Igual que `serie`. |

## 7. Workflow de GitHub Actions

Archivo: `.github/workflows/k6.yml`.

Disparador único: `workflow_dispatch`. No se ejecuta en push ni en pull request.

### 7.1 Entradas

| Entrada | Valores | Uso |
|---|---|---|
| `modo` | `smoke`, `serie`, `limites`, `individual` | Define la corrida. |
| `vus` | `50`, `100`, `500`, `1000` | Solo para `individual`. |
| `rampa` | texto, por defecto `1m` | Solo para `individual`. |
| `duracion` | texto, por defecto `3m` | Solo para `individual`. |
| `lecturas` | texto, por defecto `20` | Porcentaje de lecturas. |

Comportamiento:

- `smoke`: fuerza 2 VUs, rampa 10s y régimen 20s.
- `serie`: recorre 50, 100, 500 y 1000 con 30 s de enfriamiento.
- `limites`: fuerza 500 VUs.
- `individual`: usa `vus`, `rampa` y `duracion`.

### 7.2 Secrets y variables

| Nombre | Tipo | Obligatorio | Uso |
|---|---|---|---|
| `K6_BASE_URL` | secret | sí | URL pública del servicio. |

No se requiere secreto de autenticación: los tokens de demo se construyen en el escenario. La variable del servidor `ENABLE_DEMO_AUTH=true` se configura en el entorno de prueba, no en GitHub.

El workflow debe fallar con un mensaje claro si `K6_BASE_URL` falta.

### 7.3 Job

- `runs-on: ubuntu-latest`.
- `timeout-minutes: 45`.
- `concurrency` por repositorio, sin cancelar una corrida en curso.
- Checkout, validación de `K6_BASE_URL` y ejecución con `grafana/k6:0.54.0`.
- `serie` es un solo job que recorre los cuatro niveles.
- `--summary-export` por nivel, más captura del log de consola.
- Artifact `k6-<modo>-<run_id>` con todos los JSON y logs, subido con `if: always()`.
- Sin `pull_request` ni `push`.

### 7.4 Prometheus

El remote write queda comentado en el workflow. Cuando exista un endpoint público se habilita con `K6_PROMETHEUS_RW_SERVER_URL`, `K6_PROMETHEUS_RW_TREND_STATS` y la salida `experimental-prometheus-rw`. No es parte de esta propuesta.

## 8. Ejecución local

Archivo previsto: `k6/correr-local.sh`.

- Verifica `GET /health` antes de correr y falla con instrucciones si el servicio no está arriba.
- Usa la imagen `grafana/k6:0.54.0` con `--network host`.
- Escribe en `k6/resultados/`, que debe quedar en `.gitignore`.
- Modos: los mismos cuatro del workflow.
- `BASE_URL` por defecto: `http://localhost:3006`.
- No requiere `JWT_SECRETO`; requiere `ENABLE_DEMO_AUTH=true` en el servidor local.
- Para el smoke local, el backend puede correr con `ENABLE_DEMO_AUTH=true` y PostgreSQL.
- Para la corrida local con límites desactivados, reiniciar con `RATE_LIMIT_USER_PER_MIN=1000000` y `RATE_LIMIT_SERVICE_PER_MIN=1000000`.
- En Windows con Docker Desktop, si `--network host` no resuelve `localhost`, usar `http://host.docker.internal:3006` como `BASE_URL`.

El QR debe estar simulado: `M8_API_URL` vacía. El servicio usa la simulación en memoria cuando no hay M8 configurado.

## 9. Evidencia

Cada artifact contiene:

- `resumen-<testid>.json` con todos los percentiles, tasas y contadores.
- `salida-<testid>.txt` con la salida de consola.

`testid` tiene el formato `g12-<modo>-<vus>vu-<timestamp>`.

La tabla comparativa se arma con:

| Corrida | VUs | p50 | p95 | p99 | req/s | % errores | 429 | 5xx | Viajes completados | Cancelados |
|---|---|---|---|---|---|---|---|---|---|---|

No se copian resultados a `opsboard-tpi-devops` en esta propuesta. El artifact queda en el repositorio de G12. La comparación con G5 se hace después, descargando ambos artifacts.

## 10. Datos y reinicio

- Antes de cada serie se reinicia el servicio. No se truncan tablas.
- Los viajes se acumulan en la base de prueba. El volumen se registra en la bitácora.
- En G12 los límites y los QR usados viven en memoria. Reiniciar el servicio limpia ese estado.
- No se usan datos reales ni se ejecuta contra producción.

## 11. Riesgos y restricciones

| Riesgo | Tratamiento |
|---|---|
| El runner de GitHub puede saturarse a 1000 VUs. | Registrar `dropped_iterations` y CPU del runner. Si hay saturación, documentarlo y repetir en una VM dedicada en otra etapa. |
| Todavía no hay URL cloud ni secret. | El workflow queda listo; las corridas se ejecutan cuando G12 publique la URL y configure `K6_BASE_URL`. |
| Demo auth habilitada en un entorno expuesto. | Usarla solo en un entorno de prueba privado o restringido. Al terminar, volver `ENABLE_DEMO_AUTH=false`. Si la URL es pública, pasar a Keycloak y límites altos, fuera de esta propuesta. |
| Los datos se acumulan. | Reiniciar y registrar el volumen. Si hace falta una base limpia, se coordina con G12 y se truncan las tablas fuera de esta propuesta. |
| El runner no es el servicio. | Documentar que el generador corre separado y que los resultados incluyen la latencia de red. |
| No hay Prometheus. | La evidencia primaria es el JSON. El remote write queda comentado. |

## 12. Checklist de implementación para @n1krov 🐔

1. Crear `k6/escenarios/ciclo-de-viaje.js` con el flujo, tokens, tags, contadores y umbrales de esta propuesta.
2. Crear `k6/correr-local.sh` con los cuatro modos y la verificación de `/health`.
3. Crear `k6/README.md` con el runbook y los comandos.
4. Crear `.github/workflows/k6.yml` con `workflow_dispatch`, los cuatro modos, `K6_BASE_URL`, artifacts y el bloque de Prometheus comentado.
5. Agregar `k6/resultados/` al `.gitignore`.
6. No tocar código de la aplicación ni el contrato.
7. Adjuntar evidencia del smoke local y del smoke cloud en la PR de implementación.

## 13. Criterios de aceptación

- El smoke local completa al menos un viaje y no tiene errores.
- El smoke cloud responde contra la URL publicada con `ENABLE_DEMO_AUTH=true`.
- La serie de cuatro niveles termina y sube sus artifacts.
- La serie cumple los umbrales de `serie`.
- La corrida de límites muestra `429 > 0` y `5xx = 0`.
- No hay secretos en el repositorio.
- El README permite repetir las corridas sin decisiones adicionales.

## 14. Fuera de alcance

- Cambios en el código de M6 o en el contrato OpenAPI.
- Despliegue del servicio.
- Activación de Prometheus remote write.
- Smoke automático en pull requests.
- Truncado o limpieza de la base.
- Keycloak con usuarios reales.
- Copia automática de resultados a opsboard.
