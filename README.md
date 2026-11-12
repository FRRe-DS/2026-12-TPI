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
* **Contenedores:** **Docker Compose** — Entorno reproducible mediante imágenes OCI para la instancia de PostgreSQL (RNF-04).
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

Existe una relación de **uno a muchos (`1:N`)** entre la cabecera del viaje y su historial de eventos. Además hay una tabla auxiliar para las claves de idempotencia.

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

### 4. Enumeraciones (PostgreSQL `ENUM`)
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
La especificación detallada de los endpoints se encuentra definida bajo el estándar **OpenAPI 3.1**, en `openapi.yaml`. La API no usa prefijo de versión: las rutas son `/trips`, `/health`, etc.

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
* **Autenticación:** JWT de M1 en `Authorization: Bearer <token>`. El token debe tener `sub`, `role` (o `roles`) y vencimiento (`exp`). Sin `exp`, o vencido, se responde `401`.
* **Atajos de demostración:** el header `X-Actor-Role` / `X-Actor-Id` sin token y los tokens rápidos (`Bearer SYSTEM`, `Bearer DRIVER:<id>`) **solo funcionan con `ENABLE_DEMO_AUTH=true`**, pensado para desarrollo. Sin esa variable (o con cualquier otro valor) se responden `401`, y `/api/demo-tokens` del panel responde `404`. En cualquier entorno publicado debe quedar en `false`.
* **Pendiente:** hoy no se valida la firma del JWT (ver pendientes conocidos).

### Health checks (RNF-14)
`GET /health/details` verifica PostgreSQL con un timeout de 1,5 s y devuelve un `HealthReport`:

| Situación | HTTP | `status` |
| :--- | :--- | :--- |
| PostgreSQL responde | `200` | `OK` |
| PostgreSQL no responde o supera el timeout | `503` | `ERROR` |

RabbitMQ y Redis todavía no forman parte del módulo, por lo que figuran como `NOT_CONFIGURED` y no degradan el estado. La bandeja de salida de eventos (`outbox`) es `null` hasta que exista. El detalle de los errores nunca expone credenciales ni cadenas de conexión; el mensaje real queda solo en el log del servidor.

### Salidas Asíncronas (Catálogo de Eventos de Dominio - RNF-03)
*(En próximas iteraciones se publicarán mediante RabbitMQ según RNF-10. Hoy se publican en el bus en memoria de `event-publisher.service.ts`, que conserva los últimos 100 y los expone en el panel de demo. Convención propuesta en el contrato: exchange `m6.events` de tipo `topic` y routing keys `trip.created`, `trip.arrived`, `trip.started`, `trip.completed` y `trip.cancelled`.)*

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
| `TripCompleted` | `POST /trips/{id}/complete` | `TripCompletedPayload` | M7, M8, M4, M2, M3 | Cobro y liquidación (RF-7.3 / RF-7.8); comprobante PDF (RF-8.4); liberar conductor (RF-4.4); habilitar calificaciones (RF-2.5 / RF-3.7). |
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
* **M8:** validación del token / QR de un solo uso en `POST /trips/{id}/start`. Ante timeout o indisponibilidad se responde `503` sin modificar el estado (RNF-13). Hoy la validación está simulada dentro de `TripService` (ver pendientes).
* **M1:** validación del JWT y sus claims (`sub`, `role`, `exp`) en cada operación protegida (RF-1.4).

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

### Pendientes conocidos (deuda técnica)

| Tema | Estado | Impacto |
| :--- | :--- | :--- |
| Verificación de la firma del JWT | Hoy se decodifica el token y se leen `sub`, `role` y `exp`, pero **no se valida la firma**: un token fabricado con rol `SYSTEM` sería aceptado | Depende de M1 (clave pública / JWKS). Es el pendiente más importante antes de un entorno real (RF-1.4 / RNF-06) |
| Validación del QR contra M8 | Simulada dentro de `TripService` (tokens de prueba como `invalid`, `expired` o `simulate_503`); los tokens ya usados se guardan en memoria | Se pierden al reiniciar el servidor; queda para integrar M8 real (RF-6.4 / RNF-13) |
| Bus de eventos | En memoria (`event-publisher.service.ts`), guarda los últimos 100 | Se pierde al reiniciar el servidor; queda para la iteración con RabbitMQ (RNF-10) |
| RabbitMQ, Redis y outbox | No están integrados: `/health/details` los informa como `NOT_CONFIGURED` y `outbox` como `null` | Hasta entonces no hay entrega garantizada de eventos ni estado compartido entre instancias |
| Límite de pedidos | Se cuenta en memoria dentro de cada proceso | Con varias instancias del servicio cada una cuenta por separado; con Redis sería compartido (RNF-12) |
| Panel de demo (`/api/*`) | Los endpoints del panel (`seed`, `trips`, `transition`) no usan autenticación | Son solo para desarrollo; no deben exponerse en un entorno publicado |
| Caída real de PostgreSQL sin test automático | El `503` de `/health/details` se prueba con una falla simulada (`spyOn` sobre la consulta a la base); ningún test apaga PostgreSQL de verdad | Se verifica a mano: `docker compose stop db` y `curl.exe -i http://localhost:3006/health/details` (debe dar `503`) |

---

## Estructura del Repositorio

```text
.
├── openapi.yaml              Contrato de las interfaces síncronas y catálogo de eventos (RNF-03)
├── docker-compose.yml        Servicios db (PostgreSQL) y backend (RNF-04)
├── .dockerignore             Archivos que no entran a la imagen del backend
├── .env.example              Variables para Docker Compose (PostgreSQL)
├── frontend/                 Panel de demo (index.html) y Swagger UI (swagger.html)
└── backend/
    ├── Dockerfile            Imagen del backend (Node 22; aplica migraciones y arranca el servidor)
    ├── .env.example          Variables del servidor (RNF-06)
    ├── package.json          Dependencias y scripts (npm run dev, npm test, npm run test:integration)
    ├── vitest.config.ts      Configuración de `npm test` (solo tests unitarios)
    ├── vitest.integration.config.ts  Configuración de `npm run test:integration` (base de tests, archivos en serie)
    ├── prisma/
    │   ├── schema.prisma     Modelos Trip, TripEventHistory e IdempotencyKey
    │   └── migrations/       Historial de migraciones SQL versionadas
    ├── generated/prisma/     Cliente tipado de Prisma (se genera con `npx prisma generate`; no versionado)
    ├── src/
    │   ├── explorer.ts       Arranque del servidor HTTP y endpoints del panel de demo
    │   ├── config/           Conexión a la base y armado de dependencias
    │   ├── routes/           Enrutamiento de las rutas del contrato
    │   ├── controllers/      Validación de la entrada y formato de la respuesta HTTP
    │   ├── services/         Lógica de negocio, eventos, idempotencia y health
    │   ├── repositories/     Acceso a PostgreSQL con Prisma
    │   ├── domain/           Máquina de estados y reglas de cancelación (lógica pura)
    │   ├── mappers/          Conversión de filas a los esquemas del contrato
    │   └── middlewares/      Autenticación, errores, precondiciones (If-Match) y límite de pedidos
    └── tests/
      ├── *.test.ts         Tests unitarios (dominio, autenticación, cabeceras, idempotencia, eventos y health)
      └── integration/      Tests de integración: servidor real y PostgreSQL de pruebas
         ├── global-setup.ts  Crea y migra la base m6_trips_test una vez antes de los tests
         ├── helpers.ts       Arranque del servidor, limpieza de tablas, cliente HTTP y atajos de creación
         └── *.test.ts        Health y autenticación, creación y consulta, ciclo de vida, cancelación, idempotencia, límite de cuerpo, límite de pedidos y falla de health
```

---

## Guía de Instalación y Ejecución Local (RNF-04 y RNF-06)

### Prerrequisitos
* **Docker y Docker Compose** (siempre; levantan PostgreSQL y, si se quiere, el backend).
* **Node.js** v22.12 o superior (solo para ejecutar el backend fuera de Docker, los tests y Prisma Studio; lo exige la versión de Vitest del proyecto).

### Opción A: todo con Docker (sin instalar Node)

Levanta PostgreSQL y el backend en contenedores. Desde la raíz del repositorio:

1. Crear el archivo `.env` en la **raíz**, copiado de `.env.example`, con `POSTGRES_USER`, `POSTGRES_PASSWORD` y `POSTGRES_DB`. El `backend/.env` **no hace falta** en Docker: Compose le pasa al contenedor las variables que necesita (`DATABASE_URL` apuntando al servicio `db`, `PORT` y `ENABLE_DEMO_AUTH`).
2. Construir y levantar:
   ```bash
   docker compose up -d --build
   ```
   Al arrancar, el contenedor del backend aplica las migraciones pendientes (`prisma migrate deploy`) y luego inicia el servidor.
3. Verificar: `http://localhost:3006/health/details` debe responder `status: OK`. El panel visual está en `http://localhost:3006` y Swagger en `http://localhost:3006/docs`.
4. Detener:
   ```bash
   docker compose down        # conserva los datos de la base
   docker compose down -v     # borra también los datos (volumen m6_pgdata)
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
   ```

   Variables opcionales del servidor:

   | Variable | Por defecto | Descripción |
   | :--- | :--- | :--- |
   | `DATABASE_URL` | (obligatoria) | Conexión a PostgreSQL. |
   | `PORT` | `3006` | Puerto del servidor (RNF-06). |
   | `CLIENT_NO_SHOW_MINUTES` | `5` | Minutos desde el arribo para aceptar `CLIENT_NO_SHOW`. |
   | `RATE_LIMIT_USER_PER_MIN` | `120` | Pedidos por minuto para usuarios. |
   | `RATE_LIMIT_SERVICE_PER_MIN` | `1200` | Pedidos por minuto para servicios (`SYSTEM`). |
   | `ENABLE_DEMO_AUTH` | desactivado | Habilita los atajos de demo (`Bearer SYSTEM`, `X-Actor-Role`, `/api/demo-tokens`). Solo desarrollo. |
   | `APP_VERSION` | versión de `package.json` | Versión que informa `/health/details`. |

3. **Levantar la base de datos PostgreSQL con Docker (RNF-04), desde la raíz del repositorio:**
   ```bash
   docker compose up -d db
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
   npm run test:integration    # tests de integración: necesitan PostgreSQL levantado (docker compose up -d db)
   ```
   Los tests de integración levantan el servidor real en un puerto libre y lo ejercitan por HTTP contra una base **separada** llamada `m6_trips_test`, dentro del mismo PostgreSQL de Docker:
   * La base de tests se **crea y migra sola** la primera vez (no hace falta ningún paso manual), y se vacía antes de cada test.
   * **No tocan la base de desarrollo** (`m6_trips`): el nombre de la base de tests se calcula a partir de `DATABASE_URL` agregando el sufijo `_test`, y si no termina en `_test` los tests se detienen antes de borrar nada. Se puede indicar otra base con la variable `TEST_DATABASE_URL`.
   * No chocan con el servidor de desarrollo ni con el contenedor del backend, porque usan su propio puerto.
   * Cubren la creación idempotente de viajes, el ciclo `arrived`, `start` y `complete` (con `closure` y `durationSeconds`), la cancelación por rol y sus motivos, las precondiciones (`ETag`, `If-Match`, `If-None-Match`), `Idempotency-Key`, los límites de tamaño del cuerpo (`413`) y de pedidos (`429`), la autenticación, los permisos de lectura y `/health/details` (incluido el `503` cuando PostgreSQL falla, simulado en el test).

   Para chequear los tipos sin ejecutar nada: `npx tsc --noEmit`.

7. **(Opcional) Explorar las tablas visualmente con Prisma Studio:**
   ```bash
   npx prisma studio
   ```

### Cómo correr los tests de cada requisito

Cada requisito funcional tiene su propio test, con el nombre `rf-6.x-...`. Todos los comandos se corren **desde `backend`**. Los unitarios no necesitan Docker; los de integración necesitan PostgreSQL levantado (`docker compose up -d db`, desde la raíz del repo).

| Requisito | Test unitario | Test de integración |
| :--- | :--- | :--- |
| RF-6.1 Estados del viaje | `npx vitest run tests/rf-6.1-estados-viaje.test.ts` | `npx vitest run --config vitest.integration.config.ts tests/integration/rf-6.1-estados-viaje.test.ts` |
| RF-6.3 Arribo del conductor | `npx vitest run tests/rf-6.3-driver-arrived.test.ts` | `npx vitest run --config vitest.integration.config.ts tests/integration/rf-6.3-arribo-conductor.test.ts` |

> **Para el equipo:** cuando termines el test de tu requisito, agregá tu fila a esta tabla con el mismo formato. Si tu requisito tiene un solo tipo de test (solo unitario o solo integración), poné `—` en la otra columna. Para correr todo: `npm test` y `npm run test:integration`.

**Qué cubre el RF-6.1:**
* **Unitario:** la máquina de estados completa (5 estados × 5 destinos × 4 roles): las 10 transiciones permitidas, las 14 rechazadas por rol (`403`) y las 76 ilegales (`409`); los estados terminales, el rol `SYSTEM`, `getAllowedTransitions` y que los estados coincidan con el contrato (`openapi.yaml`) y con el enum de Prisma.
* **Integración:** lo mismo por HTTP con la base real: el ciclo completo, cada acción (`arrived`, `start`, `complete`, `cancel`) desde cada estado, quién puede ejecutarla, que un rechazo no cambie el estado ni deje historial ni eventos, el `404` de viaje inexistente y la concurrencia de dos `arrived` simultáneos.
* **Lo que no cubre, a propósito:** el QR (RF-6.4), el cierre del viaje (RF-6.5), los motivos de cancelación (RF-6.6 y RF-6.7) y la forma del historial (RF-6.8), que tienen su propio test.

**Qué cubre el RF-6.3:**
* **Unitario (`tests/rf-6.3-driver-arrived.test.ts`):** la lógica de negocio de `TripService.markDriverArrived(...)` aislada con mocks: transición válida de `PENDING_ARRIVAL` a `DRIVER_ARRIVED`, registro de marca temporal `arrivedAt`, publicación del evento de dominio `DriverArrived` con payload `{ clientId, driverId }` hacia M8, rechazo por rol para `CLIENT`, `OPERATOR` y `SYSTEM` (`403 FORBIDDEN`), rechazo de conductor no asignado (`403 FORBIDDEN`), viaje inexistente (`404 TRIP_NOT_FOUND`), conflicto de estados cuando no está en `PENDING_ARRIVAL` (`409 INVALID_STATE_TRANSITION`), precondición de versión `If-Match` (`412 PRECONDITION_FAILED`) y conflicto por actualización concurrente en base (`409 CONCURRENCY_CONFLICT`).
* **Integración (`tests/integration/rf-6.3-arribo-conductor.test.ts`):** ejercitación HTTP real de `POST /trips/{id}/arrived` contra PostgreSQL: persistencia atómica en base de datos, actualización de versión y cabecera `ETag: "2"`, emisión del evento `DriverArrived`, rechazo de roles no autorizados (`403`), validación de identificador UUID (`400 VALIDATION`) y viaje inexistente (`404`), rechazo de arribo redundante (`409 INVALID_STATE_TRANSITION`), control de concurrencia optimista (`412 PRECONDITION_FAILED`) e idempotencia con `Idempotency-Key` (cabecera `Idempotent-Replayed: true` devolviendo el mismo `200` sin re-ejecutar la transición).
* **Lo que no cubre, a propósito:** la creación del viaje (RF-6.1 / M5), el inicio validado por QR (RF-6.4), el cierre con odómetro (RF-6.5), cancelaciones (RF-6.6 / RF-6.7) ni consultas de historial (RF-6.8), que corresponden a los demás requisitos.

### Probar la API desde la terminal

Con `ENABLE_DEMO_AUTH=true`, el token rápido `SYSTEM` permite consultar sin un JWT real. Por ejemplo (en PowerShell se usa `curl.exe`, no `curl`):

```bash
curl -i http://localhost:3006/health/details
curl -i "http://localhost:3006/trips?clientId=<UUID_DEL_CLIENTE>" -H "Authorization: Bearer SYSTEM"
```

Para crear un viaje (`POST /trips`) y recorrer sus acciones hace falta un cuerpo JSON válido según `CreateTripRequest` en `openapi.yaml`; es más cómodo hacerlo desde Swagger UI o desde el panel de demo.