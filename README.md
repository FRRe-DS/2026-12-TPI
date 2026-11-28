# Módulo M6: Viajes y Ciclo de Vida 
**Desarrollo de Software - 2026 | Grupo 12**

Repositorio correspondiente al **Módulo M6 (Viajes y Ciclo de Vida)** de la plataforma distribuida de movilidad urbana bajo demanda.

## Integrantes - Grupo 12
* Ayala Trangoni Malena Esperanza - Legajo: 27754
* Di Rado Luciano - Legajo: 26957
* Fankhauser Agostina - Legajo: 27311
* Kowtun Andrea - Legajo: 27049
* Montiel Lautaro Agustín - Legajo: 28810 
* Pared Chudy Nahuel - Legajo: 25696
* Pozzer Maurizio - Legajo: 27420
* Vignoles Francisco - Legajo: 27259

---

## Responsabilidad del Módulo
El objetivo central del Módulo M6 es gestionar de forma autónoma la **máquina de estados de un viaje**, garantizando que su ciclo de vida avance únicamente mediante transiciones válidas, controlando la concurrencia y manteniendo un historial de auditoría inmutable y no destructivo.

El contrato de la API (`openapi.yaml`) está **unificado con el Grupo 5**, que también implementa M6. Este README describe lo que implementa el código de este repositorio; ante cualquier diferencia, manda el contrato.

### Requerimientos Funcionales Cubiertos
* **RF-6.1 (Estados del viaje):** Administración de estados válidos y transiciones controladas.
* **RF-6.2 (Consulta de estado):** Exposición del estado actual y resumen del viaje para clientes, conductores, operadores y servicios autorizados.
* **RF-6.3 (Arribo del conductor):** Registro de llegada del conductor asignado al punto de retiro (`DRIVER_ARRIVED`).
* **RF-6.4 (Inicio validado):** Inicio del viaje (`IN_PROGRESS`) tras verificar la condición acordada (código QR / token de un solo uso validado contra M8).
* **RF-6.5 (Finalización):** Cierre del viaje (`COMPLETED`) registrando el cierre (`closure`): distancia (`distanceKm`) y duración exacta (`durationSeconds`) calculada por M6.
* **RF-6.6 (Cancelación por cliente):** Cancelación con motivo del catálogo y tiempo transcurrido para evaluación de eventuales cargos en M7.
* **RF-6.7 (Cancelación por conductor):** Cancelación con motivo justificado y bandera `requiresRedispatch` para que M5 sepa si debe buscar otro conductor.
* **RF-6.8 (Historial de transiciones):** Registro de auditoría de solo inserción (`TripEventHistory`) con secuencia, estado de origen y destino, acción, actor, fecha/hora y motivo.

---

## Stack Tecnológico y Justificación (RNF-01)
* **Lenguaje:** **TypeScript (Node.js)** — Aporta tipado estático fuerte sobre el ecosistema JavaScript, previniendo errores en tiempo de compilación al manipular contratos, estados del viaje y payloads. El servidor usa el módulo `http` nativo de Node, sin framework.
* **Base de Datos:** **PostgreSQL** — Motor relacional con soporte transaccional ACID completo, ideal para garantizar integridad referencial, manejo nativo de JSON y control de concurrencia (RNF-08).
* **ORM:** **Prisma ORM (v6.19)** — Definición declarativa del esquema (`backend/prisma/schema.prisma`), migraciones SQL versionadas (`backend/prisma/migrations`) y cliente tipado autogenerado en `backend/generated/prisma`.
* **Contenedores:** **Docker Compose** — Entorno reproducible mediante imágenes OCI para PostgreSQL, RabbitMQ, Keycloak y el backend (RNF-04).
* **Mensajería:** **RabbitMQ** (cliente `amqplib`) — Publica los eventos de dominio de forma asíncrona, para que M6 no dependa de que los consumidores estén disponibles (RNF-10).
* **Contratos:** **OpenAPI 3.1.0** — Definición estandarizada de la interfaz REST del módulo, sus respuestas de error y los esquemas de eventos (RNF-03).
* **Tests:** **Vitest** — Tests unitarios de la lógica de dominio y de los componentes transversales (`npm test`) y tests de integración que ejercitan los endpoints reales contra una base PostgreSQL de pruebas (`npm run test:integration`).

---

## Máquina de Estados del Viaje (RF-6.1)

El siguiente diagrama representa las únicas transiciones permitidas por el módulo. Los estados `COMPLETED` y `CANCELLED` son terminales e inmutables.

```mermaid
stateDiagram-v2
    [*] --> PENDING_ARRIVAL : POST /trips (Desde M5)

    PENDING_ARRIVAL --> DRIVER_ARRIVED : POST /trips/{id}/arrived (Conductor)
    PENDING_ARRIVAL --> CANCELLED : POST /trips/{id}/cancel (Cliente, Conductor u Operador)

    DRIVER_ARRIVED --> IN_PROGRESS : POST /trips/{id}/start (Valida QR en M8)
    DRIVER_ARRIVED --> CANCELLED : POST /trips/{id}/cancel (Cliente, Conductor u Operador)

    IN_PROGRESS --> COMPLETED : POST /trips/{id}/complete (Registra km y duración)
    IN_PROGRESS --> CANCELLED : POST /trips/{id}/cancel (solo Operador)

    COMPLETED --> [*]
    CANCELLED --> [*]
```

### Cancelación (RF-6.6 y RF-6.7)

El estado destino es siempre `CANCELLED`. Quién canceló, el motivo y si hay que re-despachar quedan guardados en el viaje (objeto `cancellation`) y en el historial. Cada rol solo puede usar los motivos de su fila; si no corresponde, se responde `422 REASON_NOT_ALLOWED`.

| Rol | Desde | Motivos permitidos | `requiresRedispatch` |
| :--- | :--- | :--- | :--- |
| `CLIENT` titular del viaje | `PENDING_ARRIVAL`, `DRIVER_ARRIVED` | `CHANGE_OF_PLANS`, `EXCESSIVE_DELAY`, `DRIVER_NO_SHOW`, `OTHER` | `false` |
| `DRIVER` asignado | `PENDING_ARRIVAL`, `DRIVER_ARRIVED` | `CLIENT_NO_SHOW`, `VEHICLE_PROBLEM`, `ORIGIN_UNREACHABLE`, `OTHER` | `true`, salvo con `CLIENT_NO_SHOW` (`false`) |
| `OPERATOR` | `PENDING_ARRIVAL`, `DRIVER_ARRIVED`, `IN_PROGRESS` | `SECURITY_INCIDENT`, `ADMINISTRATIVE_BLOCK`, `OTHER` | `false` |

`CLIENT_NO_SHOW` solo se acepta desde **5 minutos** después de `arrivedAt` (configurable con `CLIENT_NO_SHOW_MINUTES`). Con `OPERATOR` el valor es siempre `false`: si hace falta re-despachar, lo pide el operador explícitamente, así M5 nunca recibe dos pedidos de asignación por el mismo viaje.

---

## Modelo de Persistencia y Diccionario de Datos (RNF-05)

Cumpliendo con el principio de **propiedad de datos**, el Módulo M6 administra su propia base de datos **PostgreSQL** de forma autónoma mediante **Prisma ORM**. No se almacenan datos internos de perfiles ni tarifas, referenciando a otros dominios únicamente por sus identificadores.

Existe una relación de **uno a muchos (`1:N`)** entre la cabecera del viaje y su historial de eventos. Además hay dos tablas auxiliares: las claves de idempotencia y la bandeja de salida de eventos.

### 1. Tabla `Trip` (Cabecera del viaje)
Almacena el estado vigente y los datos principales del viaje.

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PK`, No nulo | Identificador único del viaje generado automáticamente. |
| `requestId` | `UUID` | **`UNIQUE`**, No nulo | Identificador de la solicitud de despacho de M5 que originó el viaje (clave de idempotencia / RNF-09). |
| `clientId` | `UUID` | No nulo | Identificador del cliente asociado al viaje (dominio M2). |
| `driverId` | `UUID` | No nulo | Identificador del conductor asignado por despacho (dominio M3). |
| `vehicleId` | `UUID` | No nulo | Identificador del vehículo asignado (dominio M3). |
| `vehicleType` | `VehicleType (Enum)` | No nulo | Tipo de vehículo (`AUTO` / `MOTO`), copia del dato de M3 al momento de la asignación. |
| `reservationId` | `UUID` | Nullable | Reserva asociada, si el viaje proviene de una. |
| `originAddress` / `destinationAddress` | `String` | Nullable | Direcciones en texto (hasta 300 caracteres). |
| `originLatitude` / `originLongitude` | `DOUBLE PRECISION` | No nulo | Coordenadas del punto de retiro. |
| `destinationLatitude` / `destinationLongitude` | `DOUBLE PRECISION` | No nulo | Coordenadas del destino final. |
| `state` | `TripState (Enum)` | No nulo (Default: `PENDING_ARRIVAL`) | Estado vigente dentro de la máquina de estados. |
| `version` | `Int` | No nulo (Default: `1`) | Sube de a uno con cada transición. Se expone como `ETag` (RNF-08). |
| `arrivedAt` / `startedAt` / `completedAt` / `cancelledAt` | `DateTime` | Nullable | Hitos del viaje, completados cuando ocurren. |
| `cancelledBy` | `ActorRole (Enum)` | Nullable | Rol que canceló (`CLIENT`, `DRIVER` u `OPERATOR`). |
| `cancellationReason` | `CancellationReason (Enum)` | Nullable | Motivo del catálogo de cancelación. |
| `cancellationDetail` | `String` | Nullable | Texto libre opcional (hasta 500 caracteres). |
| `cancelledFromState` | `TripState (Enum)` | Nullable | Estado en el que estaba el viaje al cancelarse. |
| `requiresRedispatch` | `Boolean` | Nullable | Si M5 debe buscar otro conductor. |
| `distanceKm` | `Float` | Nullable | Distancia recorrida registrada al finalizar (RF-6.5). |
| `durationSeconds` | `Int` | Nullable | Duración exacta calculada por M6 (`completedAt − startedAt`). Es el valor que M7 usa para tarifar. |
| `durationMinutes` | `Int` | Nullable | La misma duración, redondeada y con mínimo 1, solo para mostrar. |
| `finalLatitude` / `finalLongitude` | `DOUBLE PRECISION` | Nullable | Posición informada por el conductor al finalizar. |
| `createdAt` | `DateTime` | No nulo (Default: `now()`) | Fecha y hora de creación del viaje. |
| `updatedAt` | `DateTime` | No nulo (Auto) | Fecha y hora de la última modificación de la fila. |

Índices: `clientId` y (`driverId`, `state`).

### 2. Tabla `TripEventHistory` (Auditoría inmutable - RF-6.8)
Funciona como un registro *append-only* (solo inserción). Los registros existentes nunca se modifican ni se eliminan; cada transición agrega una nueva fila para mantener trazabilidad completa.

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PK`, No nulo | Identificador único del evento de auditoría. |
| `tripId` | `UUID` | `FK` (`Trip.id`, `ON DELETE RESTRICT`), No nulo | Referencia al viaje al que pertenece el evento. |
| `sequence` | `Int` | No nulo, **`UNIQUE`** junto con `tripId` | Número de la transición dentro del viaje (1 al crear, igual a la `version` resultante). |
| `fromState` | `TripState (Enum)` | Nullable | Estado de origen. Es nulo en la creación. |
| `state` | `TripState (Enum)` | No nulo | Estado al que transicionó el viaje con este evento. |
| `action` | `TripAction (Enum)` | No nulo | Acción ejecutada (`CREATE`, `REGISTER_ARRIVAL`, `START`, `COMPLETE`, `CANCEL`). |
| `actorId` | `String` | No nulo | Quién ejecutó la acción. Con rol `SYSTEM` lleva el nombre del servicio (por ejemplo `m5-dispatch-service`), no un UUID. |
| `actorRole` | `ActorRole (Enum)` | No nulo | Rol del actor que ejecutó la acción. |
| `reason` | `String` | Nullable (presente en cancelaciones) | Motivo del catálogo de cancelación (RF-6.6 / RF-6.7). |
| `detail` | `String` | Nullable | Detalle libre de la cancelación. |
| `metadata` | `JSONB` | Nullable | Datos adicionales estructurados (ej. `distanceKm` y `durationSeconds` al finalizar). |
| `createdAt` | `DateTime` | No nulo (Default: `now()`) | Marca temporal exacta de la transición. |

### 3. Tabla `IdempotencyKey` (`idempotency_keys`)
Registro de las claves `Idempotency-Key` recibidas, para devolver la misma respuesta ante un reintento (RNF-09).

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PK`, No nulo | Identificador de la fila. |
| `actorId` / `key` | `String` / `VARCHAR(200)` | **`UNIQUE`** en conjunto | La clave es propia de cada usuario o servicio: dos actores distintos no se pisan. |
| `fingerprint` | `String` | No nulo | Hash de método, ruta y cuerpo del pedido original. Detecta el reuso de la clave con otro pedido. |
| `responseStatus` / `responseBody` / `responseEtag` | `Int` / `JSONB` / `String` | Nullable | Respuesta exitosa guardada. Mientras son nulos, el pedido original sigue en proceso. |
| `createdAt` / `expiresAt` | `DateTime` | No nulo | La clave se recuerda 24 horas. |

### 4. Tabla `OutboxEvent` (`outbox_events`)
Bandeja de salida: eventos de dominio guardados junto con el cambio del viaje, a la espera de enviarse a RabbitMQ (RNF-10).

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `Int` | `PK`, autoincremental | Define el orden de envío. |
| `eventId` | `UUID` | **`UNIQUE`**, No nulo | Identificador del evento. |
| `eventType` / `tripId` | `String` / `UUID` | No nulo | Tipo de evento y viaje afectado. |
| `envelope` | `JSONB` | No nulo | Sobre completo (`EventEnvelope`) tal como se envía. |
| `createdAt` | `DateTime` | No nulo (Default: `now()`) | Cuándo se guardó. |
| `publishedAt` | `DateTime` | Nullable | Cuándo confirmó el broker. Nulo mientras está pendiente. |
| `attempts` / `lastError` | `Int` / `String` | Default `0` / Nullable | Intentos de envío y motivo del último fallo. |

Índice: (`publishedAt`, `id`).

### 5. Enumeraciones (PostgreSQL `ENUM`)
| Enum | Valores | Uso |
| :--- | :--- | :--- |
| `TripState` | `PENDING_ARRIVAL`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED` | Estado del viaje (`Trip.state`, `TripEventHistory.state` y `fromState`). |
| `VehicleType` | `AUTO`, `MOTO` | Tipo de vehículo del viaje. |
| `ActorRole` | `CLIENT`, `DRIVER`, `OPERATOR`, `SYSTEM` | Rol del actor de cada transición. |
| `CancellationReason` | `CHANGE_OF_PLANS`, `EXCESSIVE_DELAY`, `DRIVER_NO_SHOW`, `CLIENT_NO_SHOW`, `VEHICLE_PROBLEM`, `ORIGIN_UNREACHABLE`, `SECURITY_INCIDENT`, `ADMINISTRATIVE_BLOCK`, `OTHER` | Motivo de cancelación. |
| `TripAction` | `CREATE`, `REGISTER_ARRIVAL`, `START`, `COMPLETE`, `CANCEL` | Acción que originó cada fila del historial. |

---

## Contratos e Integraciones con Otros Módulos (RNF-03)

### Entradas Síncronas (API REST Expuesta)
La especificación detallada de los endpoints se encuentra definida bajo el estándar **OpenAPI 3.1**, en `openapi.yaml`. La forma canónica de las rutas lleva el prefijo `/api/v1` (igual que el resto de los módulos): `POST /api/v1/trips`, `GET /api/v1/health`, etc. Por compatibilidad con los clientes existentes se mantiene también el alias sin prefijo (`POST /trips`, `GET /health`). Las tablas de este README muestran las rutas sin prefijo.

| Método | Ruta | Rol / Origen | Acción / Transición |
| :--- | :--- | :--- | :--- |
| `POST` | `/trips` | **M5 (Despacho)** / `SYSTEM` | Crea el viaje inicial en estado `PENDING_ARRIVAL` (idempotente por `requestId`). Responde `201` con `Location` la primera vez y `200` si el `requestId` ya existía con los mismos datos; con datos distintos, `409 REQUEST_ID_CONFLICT`. |
| `GET` | `/trips` | `CLIENT`, `DRIVER`, `OPERATOR`, `SYSTEM` | Historial resumido y paginado (`TripSummary`, sin coordenadas) para M2 y M4 (RF-2.4 / RF-4.7). Ver filtros más abajo. |
| `GET` | `/trips/{id}` | `CLIENT` y `DRIVER` del viaje, `OPERATOR`, `SYSTEM` | Consulta el estado actual y resumen del viaje (RF-6.2). Devuelve `ETag` y admite `If-None-Match` → `304`. |
| `POST` | `/trips/{id}/arrived` | `DRIVER` asignado | Registra arribo en punto de retiro (`DRIVER_ARRIVED` - RF-6.3). |
| `POST` | `/trips/{id}/start` | `DRIVER` asignado (valida con **M8**) | Valida QR de un solo uso e inicia viaje (`IN_PROGRESS` - RF-6.4). |
| `POST` | `/trips/{id}/complete` | `DRIVER` asignado | Cierra el viaje con la distancia informada; M6 calcula la duración desde `startedAt` (`COMPLETED` - RF-6.5). |
| `POST` | `/trips/{id}/cancel` | `CLIENT` / `DRIVER` / `OPERATOR` | Cancela el viaje con motivo obligatorio del catálogo (`CANCELLED` + `cancelledBy`), según la tabla de cancelación (RF-6.6 / RF-6.7). |
| `GET` | `/trips/{id}/history` | `CLIENT` y `DRIVER` del viaje, `OPERATOR` | Registro de auditoría de transiciones, en orden de `sequence` (RF-6.8). `SYSTEM` recibe `403`. |
| `GET` | `/health` | Público | Liveness: el proceso está vivo. No consulta dependencias (lo usa el `HEALTHCHECK` de Docker). |
| `GET` | `/health/details` | Público | Readiness y diagnóstico de dependencias (RNF-14). Ver más abajo. |

**Prefijo.** Todas las rutas de la tabla se pueden llamar con `/api/v1` delante: `POST /api/v1/trips`, `GET /api/v1/trips/{id}`, `GET /api/v1/health/details`, etc. Las dos formas llegan al mismo endpoint y el `Location` de una creación conserva el prefijo con el que se hizo el pedido.

**Permisos de lectura.** Un `CLIENT` o `DRIVER` que consulta un viaje ajeno recibe `404 TRIP_NOT_FOUND`, igual que si no existiera, para no revelar que existe.

**Listado (`GET /trips`).** `CLIENT` y `DRIVER` solo ven sus propios viajes (se ignora el filtro que envíen y se usa el id del token). `OPERATOR` ve todos, con los filtros que indique. `SYSTEM` debe indicar `clientId` o `driverId`; sin ninguno, `400 VALIDATION`. Filtros disponibles: `clientId`, `driverId`, `state` (uno o varios separados por coma, por ejemplo `state=COMPLETED,CANCELLED`), `from` (inclusive) y `to` (exclusivo) sobre la fecha de creación, y paginación con `page` (desde 1) y `pageSize` (1 a 100, por defecto 20).

### Convenciones HTTP y cabeceras

| Tema | Comportamiento |
| :--- | :--- |
| **Errores** | Siempre `application/problem+json` (RFC 9457) con `type`, `title`, `status`, `code`, `detail`, `message`, `timestamp`, `instance` y `correlationId`. Los `code` son un catálogo cerrado: `VALIDATION` (400), `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `TRIP_NOT_FOUND` y `ROUTE_NOT_FOUND` (404), `INVALID_STATE_TRANSITION`, `CONCURRENCY_CONFLICT`, `REQUEST_ID_CONFLICT` y `REQUEST_IN_PROGRESS` (409), `PRECONDITION_FAILED` (412), `PAYLOAD_TOO_LARGE` (413), `INVALID_VERIFICATION_CODE`, `REASON_NOT_ALLOWED` e `IDEMPOTENCY_KEY_REUSED` (422), `TOO_MANY_REQUESTS` (429), `INTERNAL_ERROR` (500) y `DEPENDENCY_UNAVAILABLE` (503). Los errores inesperados no exponen detalles internos. |
| **Concurrencia (RNF-08)** | Cada respuesta que devuelve un viaje incluye `ETag` con la `version` entre comillas (por ejemplo `ETag: "4"`). `GET /trips/{id}` con `If-None-Match: "4"` responde `304` sin cuerpo si nada cambió. Las acciones (`arrived`, `start`, `complete`, `cancel`) aceptan `If-Match`: si la versión no coincide, `412 PRECONDITION_FAILED` (con el `ETag` actual en la respuesta); si está mal formado, `400`. Además las escrituras se aplican con `UPDATE ... WHERE id = ? AND state = <estado esperado>`, de modo que ante dos pedidos simultáneos solo uno gana y el otro recibe `409`. |
| **Idempotencia (RNF-09)** | Las acciones aceptan `Idempotency-Key` (1 a 200 caracteres). Repetir la misma clave devuelve la respuesta original con `Idempotent-Replayed: true`, sin volver a aplicar la acción ni publicar otro evento. Se recuerda 24 horas. Si el pedido original sigue en proceso, `409 REQUEST_IN_PROGRESS`; si se reutiliza con otra ruta u otro cuerpo, `422 IDEMPOTENCY_KEY_REUSED`. Los errores no se guardan: se puede reintentar con la misma clave. |
| **Límite de pedidos (RNF-12)** | Por usuario o servicio y por minuto: 120 para usuarios y 1200 para servicios (`SYSTEM`), configurables. Cada respuesta informa `RateLimit-Limit`, `RateLimit-Remaining` y `RateLimit-Reset`; al superarlo, `429 TOO_MANY_REQUESTS` con `Retry-After`. |
| **Tamaño del cuerpo (RNF-12)** | Hasta 16 KB; si se supera, `413 PAYLOAD_TOO_LARGE`. |
| **Correlación (RNF-14)** | `X-Correlation-Id` se propaga a los logs y a los eventos; si no viene, M6 genera uno. |
| **Creación** | `POST /trips` responde `201` con `Location: /trips/{id}` y el `ETag` del viaje. |

### Seguridad (RNF-12)
* **Autenticación:** JWT de M1 (Keycloak) en `Authorization: Bearer <token>`. Se valida la **firma RS256** contra el JWKS de M1 y además `iss`, `exp`, `nbf`, `iat` y, si se configura, `aud`. Un token inválido o vencido responde `401 UNAUTHENTICATED`; si M1 no responde se responde `503 DEPENDENCY_UNAVAILABLE` con `Retry-After` (RNF-13), para no hacerle creer al cliente que su token es inválido.
* **Roles:** Keycloak emite un rol por módulo (`solicitud-be`, `viajes-be`, ...) en el claim `roles`; cualquiera de ellos se traduce a `SYSTEM`. Si el token también trae un rol de usuario (`CLIENTE`, `CONDUCTOR`, `OPERADOR`), ese tiene prioridad. En los tokens de servicio la identidad (`actorId`) es el cliente (`azp`, por ejemplo `grupo-05`), no el `sub`.
* **Configuración:** `AUTH_ISSUER` (por defecto el realm compartido `http://localhost:8080/realms/ds-2026-realm`), `AUTH_JWKS_URI`, `AUTH_AUDIENCE` (opcional), `AUTH_JWKS_TIMEOUT_MS`, `AUTH_JWKS_CACHE_MS` y `AUTH_CLOCK_TOLERANCE_SEC`. Las claves se cachean y se refrescan si aparece un `kid` nuevo. El `docker-compose.yml` del módulo levanta su propio Keycloak en `http://localhost:8081` con un realm derivado del de la cátedra y ya setea estas variables; ver [`keycloak/README.md`](keycloak/README.md). Si el JWKS no responde, se siguen usando las claves cacheadas (RNF-13): una clave revocada se sigue aceptando hasta el próximo refresco exitoso.
* **Atajos de demostración:** el header `X-Actor-Role` / `X-Actor-Id` sin token, los tokens rápidos (`Bearer SYSTEM`, `Bearer DRIVER:<id>`) y los JWT del panel (`/api/demo-tokens`) **solo funcionan con `ENABLE_DEMO_AUTH=true`**, pensado para desarrollo. Sin esa variable (o con cualquier otro valor) se responden `401`, y `/api/demo-tokens` del panel responde `404`. En cualquier entorno publicado debe quedar en `false`.

#### Qué espera M6 de un token (issue #9)

| Pregunta | Respuesta |
| :--- | :--- |
| `iss` | El valor de `AUTH_ISSUER`. Por defecto, el realm de la cátedra: `http://localhost:8080/realms/ds-2026-realm`. El `docker-compose.yml` del módulo lo setea en `http://localhost:8081/realms/ds-2026-realm`; en un entorno compartido, el emisor acordado por el consorcio. |
| `aud` | **No se exige.** El realm no emite `aud`; si se define `AUTH_AUDIENCE`, se valida. |
| Clave | **RS256** con las claves del JWKS de ese emisor (`{issuer}/protocol/openid-connect/certs`). No se aceptan HS256 ni claves compartidas. |
| Roles | Claim `roles` (o `role` / `realm_access.roles`). `CLIENTE` → `CLIENT`, `CONDUCTOR` → `DRIVER`, `OPERADOR` → `OPERATOR`, cualquier `*-be` o `SERVICIO` → `SYSTEM`. |
| Identidad | Usuarios: `sub`. Cuentas de servicio: `azp` (por ejemplo, `grupo-17`). |

Un módulo que hoy firme sus propios tokens (por ejemplo, M2 con su clave) recibe `401`. Para llamar a M6
tiene que pedir un token de servicio al Keycloak acordado (`client_credentials` con su cliente
`grupo-NN`) y enviarlo como `Bearer`.

### Health checks (RNF-14)
`GET /health/details` verifica PostgreSQL y RabbitMQ, con un timeout de 1,5 s cada uno, revisa la bandeja de salida de eventos (outbox) y devuelve un `HealthReport`:

| Situación | HTTP | `status` |
| :--- | :--- | :--- |
| Todo responde y no hay eventos atrasados | `200` | `OK` |
| RabbitMQ está configurado y no responde | `200` | `DEGRADED` |
| Hay eventos esperando envío hace más de 60 s | `200` | `DEGRADED` |
| PostgreSQL no responde o supera el timeout | `503` | `ERROR` |

* **`rabbitmq`:** `OK` o `ERROR`. Sin `RABBITMQ_URL` figura como `NOT_CONFIGURED`; los eventos se siguen guardando, así que el estado pasa a `DEGRADED` cuando alguno espera más de 60 s.
* **`outbox`:** cantidad de eventos pendientes (`pending`) y segundos que lleva esperando el más viejo (`oldestPendingSeconds`). Es `null` si no se pudo consultar, por ejemplo con la base caída.
* **`redis`:** todavía no forma parte del módulo y figura como `NOT_CONFIGURED`.

La respuesta nunca expone credenciales ni cadenas de conexión; el detalle de cada falla queda en el log del servidor.

### Telemetría para OpsBoard

Al configurar `OTEL_EXPORTER_OTLP_ENDPOINT`, el backend exporta métricas, trazas y logs por OTLP/HTTP. Sin esa variable, el servicio sigue funcionando sin exportadores. El nombre de servicio predeterminado es `m6-grupo12` y el atributo de recurso `grupo=12`; se pueden configurar con `OTEL_SERVICE_NAME` y `OTEL_RESOURCE_ATTRIBUTES`. Para correr el backend en el host junto al collector de OpsBoard, usar `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` en `backend/.env`. En Docker Compose, usar `http://host.docker.internal:4318` en el `.env` de la raíz.

El contrato de métricas coincide con el [dashboard de OpsBoard](https://github.com/universoparalelo/opsboard-tpi-devops/blob/main/docs/convencion-metricas.md): `m6_trip_transitions` cuenta cambios de estado confirmados (`from`, `to`, `actor`), `m6_trip_cancellations` cuenta cancelaciones confirmadas (`actor`, `reason`) y `m6_transition_duration` mide segundos por operación (`action`, `resultado`). Una repetición idempotente no suma otra transición. La etiqueta `actor` contiene el rol. No se usan IDs de viajes o personas como etiquetas de métricas.

El colector local de OpsBoard recibe los logs por OTLP. Si el entorno también captura `stdout`, elegir una sola de las dos fuentes para evitar duplicarlos.

Las peticiones HTTP y las consultas Prisma aparecen como spans; el span `prisma:engine:db_query` alimenta además `db_client_operation_duration_seconds`, la serie consultada por el panel de latencia PostgreSQL p95. Los logs HTTP son JSON e incluyen `trace_id`, `span_id` y `idCorrelacion` cuando están disponibles. El log registra ruta normalizada, método y estado; no incluye cuerpos, tokens, coordenadas ni SQL. Las trazas HTTP entrantes exportan la ruta normalizada y omiten los parámetros de consulta. Los indicadores de CPU, memoria, runtime y HTTP se exportan con las instrumentaciones de OpenTelemetry.

### Salidas Asíncronas (Catálogo de Eventos de Dominio - RNF-03)

M6 publica sus eventos en RabbitMQ (RNF-10), en el exchange `m6.events` de tipo `topic`:

| Evento | Routing key |
| :--- | :--- |
| `TripCreated` | `trip.created` |
| `DriverArrived` | `trip.arrived` |
| `TripStarted` | `trip.started` |
| `TripCompleted` | `trip.completed` |
| `TripCancelled` | `trip.cancelled` |

Las routing keys siguen la convención del contrato y están **pendientes de acordar con el Grupo 5**; se definen en `backend/src/config/messaging.ts`.

#### Cómo se envían (patrón outbox)

1. El evento se guarda en la tabla `outbox_events` en la **misma transacción** que el cambio del viaje: si el viaje se guarda, el evento también.
2. Un despachador revisa la tabla cada 2 s y envía los pendientes en orden (hasta 50 por pasada), esperando la confirmación del broker. Recién entonces los marca como enviados.
3. Si un envío falla, se detiene y reintenta en la pasada siguiente, para no adelantar un evento posterior.

* **Entrega "al menos una vez":** un evento puede llegar repetido.
* **Una sola instancia:** el despachador supone que corre un único M6.
* **Sin `RABBITMQ_URL`:** los eventos quedan pendientes y salen cuando se configure un broker.
* **Cada consumidor crea su cola** y la asocia al exchange (por ejemplo, con `trip.#`). El broker descarta los mensajes que no tienen ninguna cola que los reciba, y M6 los da por enviados: **no conectar M6 a un broker compartido hasta que esas colas existan**.

Para ver los eventos en desarrollo, desde `backend`: `npm run eventos:escuchar` (se corta con Ctrl+C).

Los eventos se nombran **en pasado** y describen algo que ya ocurrió. Llevan datos suficientes para que quien los reciba **no tenga que volver a preguntar** (RNF-03). Los esquemas completos están en `openapi.yaml` → `components/schemas`.

Dos reglas para los consumidores:
- **Deduplicar por `eventId`** (RNF-09): el mismo evento puede entregarse dos veces.
- **Ignorar los campos que no conozcan**: M6 puede agregar datos nuevos sin subir `eventVersion`.

#### Sobre común (`EventEnvelope`)

| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `eventId` | uuid | Único por evento. Clave de deduplicación. |
| `eventType` | string | Nombre del evento, en pasado. |
| `eventVersion` | integer | Versión del esquema del payload. Hoy `1`. |
| `occurredAt` | date-time | Momento en que ocurrió el hecho. |
| `tripId` | uuid | Viaje afectado. |
| `correlationId` | string (opcional) | Propaga el identificador del pedido original (RNF-14). |
| `payload` | object | Datos propios del evento. |

#### Eventos

| Evento | Disparador | Payload | Consumidores | Propósito |
| :--- | :--- | :--- | :--- | :--- |
| `TripCreated` | `POST /trips` | `TripCreatedPayload` | M8, M4 | M8 genera el QR de un solo uso (RF-8.3); M4 mantiene al conductor reservado (RF-4.4). |
| `DriverArrived` | `POST /trips/{id}/arrived` | `TripStatusPayload` | M8 | Aviso al cliente de que el conductor llegó (RF-8.1). |
| `TripStarted` | `POST /trips/{id}/start` | `TripStatusPayload` | M8 | Aviso de inicio del viaje (RF-8.1). |
| `TripCompleted` | `POST /trips/{id}/complete` | `TripCompletedPayload` | M7, M8, M4, M2, M3 | Cobro y liquidación (RF-7.3 / RF-7.8); comprobante PDF (RF-8.4); liberar conductor (RF-4.4); aviso de fin de viaje a M2 y M3. |
| `TripCancelled` | `POST /trips/{id}/cancel` (cualquier rol) | `TripCancelledPayload` | M7, M8, M4, M5 | Cargo de cancelación (RF-7.4); aviso a la otra parte; liberar conductor; M5 re-despacha solo si `requiresRedispatch` es `true`. |

Hay **un único evento de cancelación**. Quién canceló (`cancelledBy`), el motivo (`reason`) y si hay que re-despachar (`requiresRedispatch`) viajan en el payload, así cada consumidor decide sin necesitar eventos distintos por rol.

#### Payloads

**`TripCreatedPayload`** — en `TripCreated`

| Campo | Tipo | Para qué |
| :--- | :--- | :--- |
| `requestId` | uuid | Identifica la solicitud de M5; permite cerrar el despacho. |
| `clientId` | uuid | M8 notifica al pasajero. |
| `driverId` | uuid | M4 reserva al conductor asignado. |
| `vehicleId` | uuid | M8 y M4 identifican el vehículo del viaje. |
| `vehicleType` | `AUTO` \| `MOTO` | Tipo de vehículo del viaje. |
| `reservationId` | uuid \| null | Reserva asociada, si la hay. |
| `originLatitude`, `originLongitude`, `destinationLatitude`, `destinationLongitude` | number | Coordenadas de retiro y destino. |
| `originAddress`, `destinationAddress` | string (opcionales) | Direcciones en texto; se omiten si no hay. |

**`TripStatusPayload`** — en `DriverArrived` y `TripStarted`

| Campo | Tipo | Para qué |
| :--- | :--- | :--- |
| `clientId` | uuid | Destinatario de la notificación (RF-8.1). |
| `driverId` | uuid | Destinatario de la notificación y referencia para M4. |

**`TripCompletedPayload`** — en `TripCompleted`

| Campo | Tipo | Para qué |
| :--- | :--- | :--- |
| `clientId` | uuid | M7 cobra y M8 emite el comprobante. |
| `driverId` | uuid | M7 liquida al conductor; M4 lo libera. |
| `vehicleId` | uuid | Identifica el vehículo del viaje. |
| `vehicleType` | `AUTO` \| `MOTO` | M7 aplica la tarifa del tipo de vehículo sin consultar a M3. |
| `closure` | object | Cierre del viaje: `distanceKm` (informada por el conductor; M6 no mide distancia), `durationSeconds` (duración exacta calculada por M6, **el valor que M7 usa para tarifar**, RF-6.5 / RF-7.1) y, si el conductor las informó, `finalLatitude` y `finalLongitude`. |
| `startedAt` | date-time | Inicio real del viaje, por si M7 o M8 lo necesitan sin consultar. |
| `completedAt` | date-time | Momento del cierre. |
| `durationMinutes` | integer | La misma duración que `closure.durationSeconds`, redondeada (mínimo 1), **solo para mostrar**. |

`distanceKm` y `durationSeconds` viajan únicamente dentro de `closure`. Se envía también `durationMinutes` para que nadie tenga que redondear por su cuenta: dos consumidores que redondean distinto cobrarían distinto.

**`TripCancelledPayload`** — en `TripCancelled`

| Campo | Tipo | Para qué |
| :--- | :--- | :--- |
| `requestId` | uuid | M5 identifica la solicitud a re-despachar. |
| `clientId` | uuid | M8 notifica al pasajero. |
| `driverId` | uuid | M4 libera al conductor. |
| `cancelledBy` | `CLIENT` \| `DRIVER` \| `OPERATOR` | Quién ejecutó la cancelación (RF-6.8). |
| `reason` | `CancellationReason` | Motivo del catálogo, para el cargo (M7) y la notificación (M8). |
| `detail` | string (opcional) | Texto libre del que canceló. |
| `previousState` | `TripState` | Estado desde el que se canceló (`PENDING_ARRIVAL`, `DRIVER_ARRIVED` o `IN_PROGRESS`). |
| `requiresRedispatch` | boolean | Si M5 debe buscar otro conductor para la solicitud. |
| `secondsSinceCreation` | integer | Antigüedad del viaje al cancelarse; insumo del cargo de cancelación (RF-7.4). |

### Dependencias Síncronas Salientes
* **M8:** validación del token / QR de un solo uso en `POST /trips/{id}/start` delegada en `M8QrValidatorService` mediante `POST /api/v1/documents/qr/verify` (o simulación en memoria si `M8_API_URL` no está definida). Soporta token de servicio configurable (`M8_SERVICE_TOKEN`), timeout (`M8_TIMEOUT_MS`) y reintentos limitados ante fallas de red o `5xx` (RNF-13). Los rechazos de negocio de M8 (`400`, `404`, `410`) se traducen a `422 INVALID_VERIFICATION_CODE` sin reintentar; en cambio, cualquier falla `5xx`, timeout o error de autenticación inter-servicio (`401`/`403`, registrado en log) responde `503 DEPENDENCY_UNAVAILABLE` con cabecera `Retry-After: 5` sin alterar el estado del viaje ni mostrar falsamente al conductor que el QR es inválido.
* **M1:** validación de la firma RS256 contra el JWKS de Keycloak, más `iss`, `exp` y la traducción de roles (RF-1.4 / RNF-12). Las claves se cachean 10 minutos y se refrescan si aparece un `kid` nuevo; si M1 no responde se devuelve `503` con `Retry-After`.

---

## Decisiones de Diseño

| Decisión | Justificación |
| :--- | :--- |
| M6 guarda `vehicleType` junto al viaje (copia del dato de M3 al momento de la asignación). | M7 lo necesita para calcular la tarifa sin consultar a M3 en cada cobro (RF-7.1), y queda registrado con qué tipo de vehículo se hizo cada viaje. Es una **instantánea**, no una copia de la tabla de M3: si el vehículo cambia de tipo, los viajes anteriores conservan el valor vigente al asignarse (RNF-05). |
| Creación idempotente por `requestId` (`UNIQUE`). | Un reintento de M5 devuelve el viaje existente (`200`); el mismo `requestId` con datos distintos devuelve `409` (RNF-09). |
| `Idempotency-Key` en las acciones, con huella del pedido y respuesta guardada 24 horas. | Un reintento por red caída no repite la acción (por ejemplo, no cancela o finaliza dos veces) y recibe la respuesta original. La clave es por usuario; los errores no se guardan para poder reintentar (RNF-09). |
| Transiciones con actualización condicional: `UPDATE ... WHERE id = ? AND state = <estado esperado>`. | Si la actualización afecta 0 filas, otra petición ya cambió el estado y se responde `409`. Impide doble inicio, doble finalización o cancelación concurrente (RNF-08). |
| `version` expuesta como `ETag`, con `If-Match` opcional en las acciones. | El cliente puede asegurarse de actuar sobre la versión que vio (`412` si cambió) y evitar descargas repetidas con `If-None-Match` (RNF-08). |
| Transición e inserción en `TripEventHistory` dentro de la misma transacción. | El historial nunca queda desfasado del estado vigente (RF-6.8). |
| Autenticación servicio a servicio con rol `SYSTEM`. | M5 invoca `POST /trips` con un token de servicio emitido por M1 (RF-1.4); los usuarios finales no pueden crear viajes. |
| El historial para M2 expone `TripSummary` sin coordenadas. | Minimiza la exposición de ubicaciones (RF-4.7 / RNF-19). |
| Un cliente o conductor ajeno recibe `404` y no `403` al consultar un viaje. | No se revela que el viaje existe (RNF-19). |
| **Cancelación (RF-6.6 / RF-6.7):** cliente y conductor cancelan antes de iniciar el viaje; el operador, en cualquier estado no terminal. | Un viaje en curso solo puede cortarse por un incidente o bloqueo administrativo, que gestiona el operador. |
| **Un solo estado de cancelación:** `CANCELLED` + `cancelledBy` (`CLIENT`, `DRIVER`, `OPERATOR`), en lugar de un estado por rol. | El estado describe la situación del viaje y el actor se registra aparte, sin duplicar la máquina de estados. |
| **Un solo evento de cancelación:** `TripCancelled`, con `cancelledBy`, `reason` y `requiresRedispatch`. | Cada consumidor decide a partir del payload. M5 re-despacha solo si `requiresRedispatch` es `true`, y con `OPERATOR` nunca lo es, para no recibir dos pedidos de asignación por el mismo viaje. |
| Duración exacta en segundos (`closure.durationSeconds`) y en minutos solo para mostrar. | Un único valor para tarifar evita que dos consumidores redondeen distinto (RF-6.5 / RF-7.1). |
| Atajos de demo detrás de `ENABLE_DEMO_AUTH` y errores sin detalles internos. | Facilitan el desarrollo sin dejar un camino de entrada sin token en un entorno publicado (RNF-12 / RNF-19). |
| `/health` es liveness puro y `/health/details` hace el diagnóstico. | Si la base se cae momentáneamente, Docker no reinicia el proceso, y el diagnóstico completo queda en un endpoint aparte (RNF-14). |
| Patrón outbox: el evento se guarda en la misma transacción que el viaje. | No se pierden eventos si RabbitMQ está caído o el servidor se reinicia antes de enviarlos (RNF-10). |
| Se guarda en la outbox aunque no haya `RABBITMQ_URL`. | Un único comportamiento en todos los entornos; los pendientes salen al configurar el broker. |
| Entrega "al menos una vez". | Ante la duda se reenvía: un evento repetido se descarta por `eventId`, uno perdido no se recupera (RNF-09). |
| RabbitMQ propio en `docker compose`, con URL configurable. | Se puede desarrollar sin depender de un broker compartido y cambiar de broker sin tocar código (RNF-04 / RNF-06). |

### Pendientes conocidos (deuda técnica)

| Tema | Estado | Impacto |
| :--- | :--- | :--- |
| Roles de usuario en el realm de la cátedra | El realm solo define roles de módulo (`*-be`); no existen `CLIENTE`, `CONDUCTOR` ni `OPERADOR`, y no hay usuarios con esos roles | Sin eso no se puede probar un inicio de viaje con cliente y conductor reales; depende de M1 / la cátedra (RF-1.3 / RNF-12) |
| Permisos por módulo | Cualquier rol `*-be` se trata como `SYSTEM`; falta restringir por operación (por ejemplo, solo `solicitud-be` de M5 crea viajes) | Endurecer la autorización por operación (RF-1.4) |
| Realm no compartido con la cátedra | El `docker-compose.yml` levanta un Keycloak propio en `localhost:8081` con un realm derivado (roles y usuarios de desarrollo), porque el de la cátedra no tiene roles de usuario | Si la cátedra o M1 publican esos roles en el realm compartido, migrar y apuntar `AUTH_ISSUER` / `AUTH_JWKS_URI` a esa instancia (RNF-04 / RNF-18) |
| Validación del QR contra M8 | `M8QrValidatorService` implementa la llamada HTTP oficial a M8 (`POST /api/v1/documents/qr/verify`) con quemado atómico garantizado por M8 (Redis con TTL y 410 Gone). En modo local/desarrollo sin M8, la simulación usa un cache en memoria | En modo local sin M8, los tokens consumidos en memoria se pierden al reiniciar; en producción, M8 es la fuente de verdad. Queda a coordinar con M8 (Grupo 10) si `/documents/qr/verify` es idempotente ante reintentos por timeout para el mismo `(tripId, token)` (RF-6.4 / RNF-09 / RNF-13) |
| Acuerdo de mensajería con el Grupo 5 | Exchange, routing keys, formato y broker compartido siguen la convención del contrato, sin acuerdo cerrado | Puede haber que cambiar `backend/src/config/messaging.ts` (RNF-10) |
| Colas de los consumidores | M6 no crea las colas; un evento sin cola que lo reciba se descarta y queda marcado como enviado | No conectar a un broker compartido hasta que las colas existan |
| Una sola instancia | El despachador no reparte los pendientes entre procesos | Con varias instancias habría envíos repetidos |
| Evento que falla siempre | El despachador se detiene en el primer fallo para respetar el orden | Frena los eventos posteriores hasta resolverlo; se detecta con `DEGRADED` en `/health/details` |
| Limpieza de la outbox | Los eventos enviados no se borran | La tabla crece con el tiempo |
| Historial en memoria | El panel de demo muestra los últimos 100 eventos desde `event-publisher.service.ts` | Se vacía al reiniciar; la copia durable está en `outbox_events` |
| Redis | No está integrado y figura como `NOT_CONFIGURED` | No hay estado compartido entre instancias |
| Límite de pedidos | Se cuenta en memoria dentro de cada proceso | Con varias instancias del servicio cada una cuenta por separado; con Redis sería compartido (RNF-12) |
| Panel de demo (`/api/*`) | Los endpoints del panel (`seed`, `trips`, `transition`) no usan autenticación | Son solo para desarrollo; no deben exponerse en un entorno publicado |
| Caída real de PostgreSQL sin test automático | El `503` de `/health/details` se prueba con una falla simulada (`spyOn` sobre la consulta a la base); ningún test apaga PostgreSQL de verdad | Se verifica a mano: `docker compose stop db` y `curl.exe -i http://localhost:3006/health/details` (debe dar `503`) |

---

## Estructura del Repositorio

```text
.
├── openapi.yaml              Contrato de las interfaces síncronas y catálogo de eventos (RNF-03)
├── docker-compose.yml        Servicios db, rabbitmq, keycloak y backend (RNF-04)
├── .dockerignore             Archivos que no entran a la imagen del backend
├── .env.example              Variables para Docker Compose (PostgreSQL, Keycloak y RabbitMQ)
├── frontend/                 Panel de demo (index.html) y Swagger UI (swagger.html)
└── backend/
    ├── Dockerfile            Imagen del backend (Node 22; aplica migraciones y arranca el servidor)
    ├── .env.example          Variables del servidor (RNF-06)
    ├── package.json          Dependencias y scripts (npm run dev, npm test, npm run test:integration)
    ├── vitest.config.ts      Configuración de `npm test` (solo tests unitarios)
    ├── vitest.integration.config.ts  Configuración de `npm run test:integration` (base de tests, archivos en serie)
    ├── prisma/
    │   ├── schema.prisma     Modelos Trip, TripEventHistory, IdempotencyKey y OutboxEvent
    │   └── migrations/       Historial de migraciones SQL versionadas
    ├── generated/prisma/     Cliente tipado de Prisma (se genera con `npx prisma generate`; no versionado)
    ├── src/
    │   ├── explorer.ts       Arranque del servidor HTTP y endpoints del panel de demo
    │   ├── config/           Conexión a la base y armado de dependencias
    │   ├── routes/           Enrutamiento de las rutas del contrato
    │   ├── controllers/      Validación de la entrada y formato de la respuesta HTTP
    │   ├── services/         Lógica de negocio, eventos, envío a RabbitMQ, idempotencia y health
    │   ├── repositories/     Acceso a PostgreSQL con Prisma
    │   ├── domain/           Máquina de estados y reglas de cancelación (lógica pura)
    │   ├── mappers/          Conversión de filas a los esquemas del contrato
    │   └── middlewares/      Autenticación, errores, precondiciones (If-Match) y límite de pedidos
    └── tests/
      ├── *.test.ts         Tests unitarios (dominio, autenticación, cabeceras, idempotencia, eventos, outbox y health)
      └── integration/      Tests de integración: servidor real y PostgreSQL de pruebas
         ├── global-setup.ts  Crea y migra la base m6_trips_test una vez antes de los tests
         ├── helpers.ts       Arranque del servidor, limpieza de tablas, cliente HTTP y atajos de creación
         └── *.test.ts        Health y autenticación, creación y consulta, ciclo de vida, cancelación, idempotencia, límite de cuerpo, límite de pedidos y falla de health, outbox y RabbitMQ
```

---

## Guía de Instalación y Ejecución Local (RNF-04 y RNF-06)

### Prerrequisitos
* **Docker y Docker Compose** (siempre; levantan PostgreSQL y, si se quiere, el backend).
* **Node.js** v22.12 o superior (solo para ejecutar el backend fuera de Docker, los tests y Prisma Studio; lo exige la versión de Vitest del proyecto).

### Opción A: todo con Docker (sin instalar Node)

Levanta PostgreSQL, RabbitMQ, Keycloak (identidad) y el backend en contenedores. Desde la raíz del repositorio:

1. Crear el archivo `.env` en la **raíz**, copiado de `.env.example`, con `POSTGRES_USER`, `POSTGRES_PASSWORD` y `POSTGRES_DB`. Las variables de Keycloak (`KEYCLOAK_*`) tienen valores de desarrollo en `compose`, así que se pueden omitir. El `backend/.env` **no hace falta** en Docker: Compose le pasa al contenedor las variables que necesita (`DATABASE_URL` apuntando al servicio `db`, `PORT`, `ENABLE_DEMO_AUTH` y las de autenticación `AUTH_ISSUER` / `AUTH_JWKS_URI`).
2. Construir y levantar:
   ```bash
   docker compose up -d --build
   ```
   Al arrancar, el contenedor del backend aplica las migraciones pendientes (`prisma migrate deploy`) y luego inicia el servidor.
3. Verificar: `http://localhost:3006/health/details` debe responder `status: OK`. El panel visual está en `http://localhost:3006` y Swagger en `http://localhost:3006/docs`. Keycloak queda en `http://localhost:8081` (consola de administración y emisor de tokens). El panel de RabbitMQ queda en `http://localhost:15672` (usuario `m6`, clave `m6_dev`; se cambian con `RABBITMQ_USER` y `RABBITMQ_PASSWORD` en el `.env` de la raíz).
4. Pedir un token de prueba (usuario `conductor1`, contraseña `conductor1-contrasena-de-desarrollo`):
   ```powershell
   curl.exe -s http://localhost:8081/realms/ds-2026-realm/protocol/openid-connect/token `
     -d grant_type=password -d client_id=m6-desarrollo `
     -d username=conductor1 -d password=conductor1-contrasena-de-desarrollo
   ```
   El realm, los usuarios y por qué se derivó del de la cátedra están en [`keycloak/README.md`](keycloak/README.md).
5. Detener:
   ```bash
   docker compose down        # conserva los datos de las dos bases
   docker compose down -v     # borra también los datos (volúmenes m6_pgdata, m6_keycloak_pgdata y m6_rabbitmq_data)
   ```

Si después se quiere correr el backend localmente con `npm run dev` (Opción B), primero hay que liberar el puerto 3006: `docker compose stop backend`.

### Opción B: backend local con `npm run dev`

### Paso a paso

1. **Clonar el repositorio e instalar las dependencias del backend:**
   ```bash
   git clone <URL_DEL_REPOSITORIO>
   cd 2026-12-TPI/backend
   npm install
   ```

2. **Configurar las variables de entorno (RNF-06).** Hay dos archivos, cada uno copiado de su `.env.example`:
   * `.env` en la **raíz** (lo lee Docker Compose para crear la base): `POSTGRES_USER`, `POSTGRES_PASSWORD` y `POSTGRES_DB`.
   * `backend/.env` (lo lee el servidor y Prisma):

   ```env
   POSTGRES_USER=m6user
   POSTGRES_PASSWORD=cambiar_esta_clave
   POSTGRES_DB=m6_trips
   DATABASE_URL="postgresql://m6user:cambiar_esta_clave@localhost:5433/m6_trips?schema=public"
   CLIENT_NO_SHOW_MINUTES=5
   ENABLE_DEMO_AUTH=true
   RABBITMQ_URL=amqp://m6:m6_dev@localhost:5672
   ```

   Variables opcionales del servidor:

   | Variable | Por defecto | Descripción |
   | :--- | :--- | :--- |
   | `DATABASE_URL` | (obligatoria) | Conexión a PostgreSQL. |
   | `PORT` | `3006` | Puerto del servidor (RNF-06). |
   | `RABBITMQ_URL` | desactivada | Dirección del broker (RNF-10). Sin ella los eventos quedan pendientes en la outbox. |
   | `RABBITMQ_EXCHANGE` | `m6.events` | Exchange donde se publican los eventos. |
   | `CLIENT_NO_SHOW_MINUTES` | `5` | Minutos desde el arribo para aceptar `CLIENT_NO_SHOW`. |
   | `M8_API_URL` | desactivada | URL base del módulo M8 para validación de QR (RF-6.4). Si no se indica, usa simulación en memoria. |
   | `M8_TIMEOUT_MS` | `3000` | Timeout en milisegundos para la llamada de validación contra M8 (RNF-13). |
   | `M8_SERVICE_TOKEN` | `SYSTEM` | Token de autorización de servicio a servicio (`Authorization: Bearer <token>`) enviado a M8 (RNF-06). |
   | `M8_MAX_RETRIES` | `1` | Cantidad de reintentos ante fallas transitorias de red o HTTP 503/504 de M8 (RNF-13). |
   | `M8_RETRY_DELAY_MS` | `150` | Espera en milisegundos entre reintentos contra M8. |
   | `RATE_LIMIT_USER_PER_MIN` | `120` | Pedidos por minuto para usuarios. |
   | `RATE_LIMIT_SERVICE_PER_MIN` | `1200` | Pedidos por minuto para servicios (`SYSTEM`). |
   | `ENABLE_DEMO_AUTH` | desactivado | Habilita los atajos de demo (`Bearer SYSTEM`, `X-Actor-Role`, `/api/demo-tokens`). Solo desarrollo. |
   | `AUTH_ISSUER` | `http://localhost:8080/realms/ds-2026-realm` | Emisor (`iss`) esperado en el JWT. Con el Keycloak del módulo (`Opción A` o `docker compose up -d keycloak-db keycloak`) usar `http://localhost:8081/realms/ds-2026-realm`. |
   | `AUTH_JWKS_URI` | derivada del emisor | URL del JWKS. Solo hace falta si el backend corre en contenedor y baja las claves por la red interna. |
   | `AUTH_AUDIENCE` | vacío | Audiencia esperada; el realm actual no emite `aud`, así que se deja vacía. |
   | `AUTH_JWKS_TIMEOUT_MS` | `3000` | Timeout para bajar el JWKS (RNF-13). |
   | `AUTH_JWKS_CACHE_MS` | `600000` | Cuánto se conservan las claves en memoria. |
   | `AUTH_JWKS_COOLDOWN_MS` | `5000` | Tras un fallo al bajar el JWKS, cuánto se espera antes de reintentar (evita pagar el timeout en cada pedido). |
   | `AUTH_CLOCK_TOLERANCE_SEC` | `5` | Tolerancia de reloj al validar `exp` / `nbf` / `iat`. |
   | `APP_VERSION` | versión de `package.json` | Versión que informa `/health/details`. |

3. **Levantar PostgreSQL y RabbitMQ con Docker (RNF-04), desde la raíz del repositorio:**
   ```bash
   docker compose up -d db rabbitmq
   ```

4. **Generar el cliente de Prisma y aplicar las migraciones, desde `backend`:**
   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```
   Si al traer cambios del repositorio hay migraciones nuevas, alcanza con volver a correr `npx prisma migrate dev`. Si la base local quedó inconsistente, `npx prisma migrate reset` la recrea desde cero (**borra todos los datos locales**).

5. **Levantar el servidor, desde `backend`:**
   ```bash
   npm run dev
   ```
   Con el servidor en marcha (puerto `3006` por defecto):
   * Panel visual de persistencia: `http://localhost:3006`
   * Swagger UI con el contrato: `http://localhost:3006/docs` (los botones de token requieren `ENABLE_DEMO_AUTH=true`)
   * Liveness: `http://localhost:3006/health` y diagnóstico: `http://localhost:3006/health/details`

6. **Ejecutar los tests, desde `backend`:**
   ```bash
   npm test                    # tests unitarios: no necesitan Docker ni base de datos
   npm run test:integration    # tests de integración: necesitan PostgreSQL y RabbitMQ (docker compose up -d db rabbitmq)
   ```
   Los tests de integración levantan el servidor real en un puerto libre y lo ejercitan por HTTP contra una base **separada** llamada `m6_trips_test`, dentro del mismo PostgreSQL de Docker:
   * La base de tests se **crea y migra sola** la primera vez (no hace falta ningún paso manual), y se vacía antes de cada test.
   * **No tocan la base de desarrollo** (`m6_trips`): el nombre de la base de tests se calcula a partir de `DATABASE_URL` agregando el sufijo `_test`, y si no termina en `_test` los tests se detienen antes de borrar nada. Se puede indicar otra base con la variable `TEST_DATABASE_URL`.
   * Los de RabbitMQ usan el broker local (`TEST_RABBITMQ_URL`, por defecto `amqp://m6:m6_dev@localhost:5672`) y un exchange aparte, `m6.events.test`. **Nunca usan `RABBITMQ_URL`**, así no envían eventos de prueba a un broker compartido.
   * No chocan con el servidor de desarrollo ni con el contenedor del backend, porque usan su propio puerto.
   * Cubren la creación idempotente de viajes, el ciclo `arrived`, `start` y `complete` (con `closure` y `durationSeconds`), la cancelación por rol y sus motivos, las precondiciones (`ETag`, `If-Match`, `If-None-Match`), `Idempotency-Key`, los límites de tamaño del cuerpo (`413`) y de pedidos (`429`), la autenticación, los permisos de lectura y `/health/details` (incluido el `503` cuando PostgreSQL falla, simulado en el test).

   Para chequear los tipos sin ejecutar nada: `npx tsc --noEmit`.

7. **(Opcional) Explorar las tablas visualmente con Prisma Studio:**
   ```bash
   npx prisma studio
   ```

### Antes de conectar a un broker compartido

La base de desarrollo puede tener eventos de prueba pendientes, que se enviarían apenas se configure el broker. Para evitarlo, primero confirmar que los consumidores ya crearon sus colas y después, desde la raíz del repositorio:

> ⚠️ El paso 2 **borra todos los viajes**. Es solo para la base de desarrollo: **nunca en la base real**.

1. Detener el backend: Ctrl+C donde corre `npm run dev`, o `docker compose stop backend`. Dejar `db` encendida.
2. Vaciar las tablas (ajustar usuario y base si se cambiaron en `.env`):
   ```powershell
   docker compose exec db psql -U m6user -d m6_trips -c "TRUNCATE trips, idempotency_keys, outbox_events CASCADE;"
   ```
3. Comprobar que no quedó ningún evento (debe dar `0`):
   ```powershell
   docker compose exec db psql -U m6user -d m6_trips -c "SELECT count(*) FROM outbox_events;"
   ```
4. Recién ahora, cambiar `RABBITMQ_URL` (en `backend/.env` para `npm run dev`; en el `.env` de la raíz para Docker) y volver a levantar el backend (`npm run dev` o `docker compose up -d backend`).

Mientras M6 esté conectado al broker compartido, todo viaje de prueba que se cree también se envía.

### Cómo correr los tests de cada requisito

Cada requisito funcional tiene su propio test, con el nombre `rf-6.x-...`. Todos los comandos se corren **desde `backend`**. Los unitarios no necesitan Docker; los de integración necesitan PostgreSQL, y la suite completa además RabbitMQ (`docker compose up -d db rabbitmq`, desde la raíz del repo).

| Requisito | Test unitario | Test de integración |
| :--- | :--- | :--- |
| RF-6.1 Estados del viaje | `npx vitest run tests/rf-6.1-estados-viaje.test.ts` | `npx vitest run --config vitest.integration.config.ts tests/integration/rf-6.1-estados-viaje.test.ts` |
| RF-6.2 Consulta de estado | `npx vitest run tests/rf-6.2-consulta-estado.test.ts` | `npx vitest run --config vitest.integration.config.ts tests/integration/rf-6.2-consulta-estado.test.ts` |
| RF-6.3 Arribo del conductor | npx vitest run tests/rf-6.3-driver-arrived.test.ts | npx vitest run --config vitest.integration.config.ts tests/integration/rf-6.3-arribo-conductor.test.ts |
| RF-6.4 Inicio validado | `npx vitest run tests/rf-6.4-start-trip.test.ts tests/m8-qr-validator.test.ts` | — |
| RF-6.6 Cancelación por cliente | `npx vitest run tests/rf-6.6-cancelacion-cliente.test.ts` | `npx vitest run --config vitest.integration.config.ts tests/integration/rf-6.6-cancelacion-cliente.test.ts` |
| RF-6.8 Historial de transiciones | `npx vitest run tests/rf-6.8-trip-history.test.ts` | — |
| Autenticación JWT (M1) | `npx vitest run tests/auth.test.ts tests/jwt-verifier.test.ts` | `npx vitest run --config vitest.integration.config.ts tests/integration/health-and-auth.test.ts` |

> **Para el equipo:** cuando termines el test de tu requisito, agregá tu fila a esta tabla con el mismo formato. Si tu requisito tiene un solo tipo de test (solo unitario o solo integración), poné `—` en la otra columna. Para correr todo: `npm test` y `npm run test:integration`.

**Qué cubre el RF-6.1:**
* **Unitario:** la máquina de estados completa (5 estados × 5 destinos × 4 roles): las 10 transiciones permitidas, las 14 rechazadas por rol (`403`) y las 76 ilegales (`409`); los estados terminales, el rol `SYSTEM`, `getAllowedTransitions` y que los estados coincidan con el contrato (`openapi.yaml`) y con el enum de Prisma.
* **Integración:** lo mismo por HTTP con la base real: el ciclo completo, cada acción (`arrived`, `start`, `complete`, `cancel`) desde cada estado, quién puede ejecutarla, que un rechazo no cambie el estado ni deje historial ni eventos, el `404` de viaje inexistente y la concurrencia de dos `arrived` simultáneos.
* **Lo que no cubre, a propósito:** el QR (RF-6.4), el cierre del viaje (RF-6.5), los motivos de cancelación (RF-6.6 y RF-6.7) y la forma del historial (RF-6.8), que tienen su propio test.


### Probar la API desde la terminal

Con `ENABLE_DEMO_AUTH=true`, el token rápido `SYSTEM` permite consultar sin un JWT real. Por ejemplo (en PowerShell se usa `curl.exe`, no `curl`):

```bash
curl -i http://localhost:3006/health/details
curl -i "http://localhost:3006/trips?clientId=<UUID_DEL_CLIENTE>" -H "Authorization: Bearer SYSTEM"
```

Para crear un viaje (`POST /trips`) y recorrer sus acciones hace falta un cuerpo JSON válido según `CreateTripRequest` en `openapi.yaml`; es más cómodo hacerlo desde Swagger UI o desde el panel de demo.
