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

### Requerimientos Funcionales Cubiertos
* **RF-6.1 (Estados del viaje):** Administración de estados válidos y transiciones controladas.
* **RF-6.2 (Consulta de estado):** Exposición del estado actual y resumen del viaje para clientes, conductores y operadores autorizados.
* **RF-6.3 (Arribo del conductor):** Registro de llegada del conductor asignado al punto de retiro (`DRIVER_ARRIVED`).
* **RF-6.4 (Inicio validado):** Inicio del viaje (`IN_PROGRESS`) tras verificar la condición acordada (código QR / token de un solo uso validado contra M8).
* **RF-6.5 (Finalización):** Cierre del viaje (`COMPLETED`) registrando métricas de distancia (`distanceKm`) y duración (`durationMinutes`).
* **RF-6.6 (Cancelación por cliente):** Cancelación con registro de motivo y tiempo transcurrido para evaluación de eventuales cargos en M7.
* **RF-6.7 (Cancelación por conductor):** Cancelación con motivo justificado y emisión de evento para devolver la solicitud a despacho (M5).
* **RF-6.8 (Historial de transiciones):** Registro de auditoría de solo inserción (`TripEventHistory`) con estado, actor, fecha/hora y motivo.

---

## Stack Tecnológico y Justificación (RNF-01)
* **Lenguaje:** **TypeScript (Node.js)** — Aporta tipado estático fuerte sobre el ecosistema JavaScript, previniendo errores en tiempo de compilación al manipular contratos, estados del viaje y payloads.
* **Base de Datos:** **PostgreSQL** — Motor relacional con soporte transaccional ACID completo, ideal para garantizar integridad referencial, manejo nativo de JSON y control de concurrencia (RNF-08).
* **ORM:** **Prisma ORM (v6.19)** — Definición declarativa del esquema (`prisma/schema.prisma`), migraciones SQL versionadas (`prisma/migrations`) y cliente tipado autogenerado en `./generated/prisma`.
* **Contenedores:** **Docker Compose** — Entorno reproducible mediante imágenes OCI para la instancia de PostgreSQL (RNF-04).
* **Contratos:** **OpenAPI 3.0.3** — Definición estandarizada de la interfaz REST del módulo y sus respuestas de error (RNF-03).

---

## Máquina de Estados del Viaje (RF-6.1)

El siguiente diagrama representa las únicas transiciones permitidas por el módulo. Los estados `COMPLETED`, `CANCELLED_BY_CLIENT` y `CANCELLED_BY_DRIVER` son terminales e inmutables.

```mermaid
stateDiagram-v2
    [*] --> PENDING_ARRIVAL : POST /trips (Desde M5)
    
    PENDING_ARRIVAL --> DRIVER_ARRIVED : POST /trips/{id}/arrived (Conductor)
    PENDING_ARRIVAL --> CANCELLED_BY_CLIENT : POST /trips/{id}/cancel (Cliente)
    PENDING_ARRIVAL --> CANCELLED_BY_DRIVER : POST /trips/{id}/cancel (Conductor)
    
    DRIVER_ARRIVED --> IN_PROGRESS : POST /trips/{id}/start (Valida QR en M8)
    DRIVER_ARRIVED --> CANCELLED_BY_CLIENT : POST /trips/{id}/cancel (Cliente)
    DRIVER_ARRIVED --> CANCELLED_BY_DRIVER : POST /trips/{id}/cancel (Conductor)
    
    IN_PROGRESS --> COMPLETED : POST /trips/{id}/complete (Registra km y min)
    
    COMPLETED --> [*]
    CANCELLED_BY_CLIENT --> [*]
    CANCELLED_BY_DRIVER --> [*]
```

---

## Modelo de Persistencia y Diccionario de Datos (RNF-05)

Cumpliendo con el principio de **propiedad de datos**, el Módulo M6 administra su propia base de datos **PostgreSQL** de forma autónoma mediante **Prisma ORM**. No se almacenan datos internos de perfiles ni tarifas, referenciando a otros dominios únicamente por sus identificadores.

Existe una relación de **uno a muchos (`1:N`)** entre la cabecera del viaje y su historial de eventos:

### 1. Tabla `Trip` (Cabecera del viaje)
Almacena el estado vigente y los datos principales del viaje.

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PK`, No nulo | Identificador único del viaje generado automáticamente. |
| `requestId` | `UUID` | **`UNIQUE`**, No nulo | Identificador de la solicitud de despacho de M5 que originó el viaje (clave de idempotencia / RNF-09). |
| `clientId` | `UUID` | No nulo | Identificador del cliente asociado al viaje (dominio M2). |
| `driverId` | `UUID` | No nulo | Identificador del conductor asignado por despacho (dominio M3). |
| `vehicleId` | `UUID` | No nulo | Identificador del vehículo asignado (dominio M3). El tipo `AUTO` / `MOTO` se obtiene de M3. |
| `originLatitude` / `originLongitude` | `DOUBLE PRECISION` | No nulo | Coordenadas del punto de retiro. |
| `destinationLatitude` / `destinationLongitude` | `DOUBLE PRECISION` | No nulo | Coordenadas del destino final. |
| `state` | `TripState (Enum)` | No nulo (Default: `PENDING_ARRIVAL`) | Estado vigente dentro de la máquina de estados. |
| `distanceKm` | `Float` | Nullable | Distancia recorrida registrada al finalizar (RF-6.5). |
| `durationMinutes` | `Int` | Nullable | Duración del viaje en minutos registrada al finalizar (RF-6.5). |
| `createdAt` | `DateTime` | No nulo (Default: `now()`) | Fecha y hora de creación del viaje. |
| `updatedAt` | `DateTime` | No nulo (Auto) | Fecha y hora de la última modificación de la fila. |

### 2. Tabla `TripEventHistory` (Auditoría inmutable - RF-6.8)
Funciona como un registro *append-only* (solo inserción). Los registros existentes nunca se modifican ni se eliminan; cada transición agrega una nueva fila para mantener trazabilidad completa.

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID` | `PK`, No nulo | Identificador único del evento de auditoría. |
| `tripId` | `UUID` | `FK` (`Trip.id`, `ON DELETE RESTRICT`), No nulo | Referencia al viaje al que pertenece el evento. |
| `state` | `TripState (Enum)` | No nulo | Estado al que transicionó el viaje con este evento. |
| `actorId` | `UUID` | Nullable | Identificador del usuario que ejecutó la acción. Es nulo cuando `actorRole = SYSTEM`. |
| `actorRole` | `ActorRole (Enum)` | No nulo | Rol del actor que ejecutó la acción. |
| `reason` | `String` | Nullable (Obligatorio en cancelaciones) | Motivo justificado de la cancelación (RF-6.6 / RF-6.7). |
| `metadata` | `JSONB` | Nullable | Datos adicionales estructurados (ej. `distanceKm` y `durationMinutes` al finalizar). |
| `createdAt` | `DateTime` | No nulo (Default: `now()`) | Marca temporal exacta de la transición. |

### 3. Enumeraciones (PostgreSQL `ENUM`)
| Enum | Valores | Uso |
| :--- | :--- | :--- |
| `TripState` | `PENDING_ARRIVAL`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED_BY_CLIENT`, `CANCELLED_BY_DRIVER` | Estado del viaje (`Trip.state` y `TripEventHistory.state`). |
| `ActorRole` | `CLIENT`, `DRIVER`, `OPERATOR`, `SYSTEM` | Rol del actor de cada transición (`TripEventHistory.actorRole`). |

---

## Contratos e Integraciones con Otros Módulos (RNF-03)

### Entradas Síncronas (API REST Expuesta)
La especificación detallada de los endpoints se encuentra definida bajo el estándar **OpenAPI 3.0**.

| Método | Ruta | Rol / Origen | Acción / Transición |
| :--- | :--- | :--- | :--- |
| `POST` | `/trips` | **M5 (Despacho)** / `SYSTEM` | Crea el viaje inicial en estado `PENDING_ARRIVAL` (idempotente por `requestId`). |
| `GET` | `/trips?clientId={id}&page=&pageSize=` | **M2 (Clientes)** / `CLIENT` / `OPERATOR` | Historial resumido y paginado (`TripSummary`, sin coordenadas) del cliente (RF-2.4 / RF-4.7). |
| `GET` | `/trips/{id}` | `CLIENT`, `DRIVER`, `OPERATOR` | Consulta el estado actual y resumen del viaje (RF-6.2). |
| `POST` | `/trips/{id}/arrived` | `DRIVER` | Registra arribo en punto de retiro (`DRIVER_ARRIVED` - RF-6.3). |
| `POST` | `/trips/{id}/start` | `DRIVER` (Valida con **M8**) | Valida QR de un solo uso e inicia viaje (`IN_PROGRESS` - RF-6.4). |
| `POST` | `/trips/{id}/complete` | `DRIVER` | Cierra el viaje con km y tiempo (`COMPLETED` - RF-6.5). |
| `POST` | `/trips/{id}/cancel` | `CLIENT` / `DRIVER` | Cancela el viaje registrando el motivo obligatorio (RF-6.6 / RF-6.7). |
| `GET` | `/trips/{id}/history` | `OPERATOR` | Consulta el registro de auditoría de transiciones (RF-6.8). |

### Salidas Asíncronas (Catálogo de Eventos de Dominio - RNF-03)
*(En próximas iteraciones se publicarán mediante RabbitMQ según RNF-10.)*

Todos los eventos comparten el sobre `EventEnvelope` (`eventId`, `eventType`, `eventVersion`, `occurredAt`, `tripId`, `correlationId`) y un `payload` específico. Los esquemas completos están en `openapi.yaml` → `components/schemas`. Los consumidores deben deduplicar por `eventId` (RNF-09).

| Evento | Disparador | Payload | Consumidores | Propósito |
| :--- | :--- | :--- | :--- | :--- |
| `TripCreated` | `POST /trips` | `TripCreatedPayload` | M8, M4 | M8 genera el QR de un solo uso (RF-8.3); M4 mantiene al conductor reservado (RF-4.4). |
| `DriverArrived` | `POST /trips/{id}/arrived` | `TripStatusPayload` | M8 | Aviso al cliente de que el conductor llegó (RF-8.1). |
| `TripStarted` | `POST /trips/{id}/start` | `TripStatusPayload` | M8 | Aviso de inicio del viaje (RF-8.1). |
| `TripCompleted` | `POST /trips/{id}/complete` | `TripCompletedPayload` | M7, M8, M4, M2, M3 | Cobro y liquidación (RF-7.3 / RF-7.8); comprobante PDF (RF-8.4); liberar conductor (RF-4.4); habilitar calificaciones (RF-2.5 / RF-3.7). |
| `TripCancelledByClient` | `POST /trips/{id}/cancel` (`CLIENT`) | `TripCancelledPayload` | M7, M8, M4 | Cargo de cancelación (RF-7.4); aviso al conductor; liberar conductor. |
| `TripCancelledByDriver` | `POST /trips/{id}/cancel` (`DRIVER`) | `TripCancelledPayload` | M5, M8, M4 | Devolver la solicitud a despacho (RF-6.7); aviso al cliente; liberar conductor. |

### Dependencias Síncronas Salientes
* **M8:** validación del token / QR de un solo uso en `POST /trips/{id}/start`. Ante timeout o indisponibilidad se responde `503` sin modificar el estado (RNF-13).
* **M1:** validación del JWT y sus claims (`sub`, `role`) en cada operación protegida (RF-1.4).

---

## Decisiones de Diseño

| Decisión | Justificación |
| :--- | :--- |
| Un viaje en `IN_PROGRESS` no puede cancelarse por cliente ni conductor. | Una vez validado el QR, el servicio está en curso; los incidentes durante el viaje serán gestionados por el operador (alcance TP2). |
| M6 no almacena el tipo de vehículo. | Es dato del dominio de M3 (RNF-05); M7 lo obtiene de M3 mediante `vehicleId`. |
| Creación idempotente por `requestId` (`UNIQUE`). | Un reintento de M5 devuelve el viaje existente (`200`); el mismo `requestId` con datos distintos devuelve `409` (RNF-09). |
| Transiciones con actualización condicional: `UPDATE ... WHERE id = ? AND state = <estado esperado>`. | Si la actualización afecta 0 filas, otra petición ya cambió el estado y se responde `409`. Impide doble inicio, doble finalización o cancelación concurrente (RNF-08). |
| Transición e inserción en `TripEventHistory` dentro de la misma transacción. | El historial nunca queda desfasado del estado vigente (RF-6.8). |
| Autenticación servicio a servicio con rol `SYSTEM`. | M5 invoca `POST /trips` con un token de servicio emitido por M1 (RF-1.4); los usuarios finales no pueden crear viajes. |
| El historial para M2 expone `TripSummary` sin coordenadas. | Minimiza la exposición de ubicaciones (RF-4.7 / RNF-19). |

---

## Estructura del Repositorio

* `prisma/schema.prisma`: Definición de los modelos `Trip` y `TripEventHistory` para PostgreSQL.
* `prisma/migrations/`: Historial de migraciones SQL versionadas.
* `generated/prisma/`: Cliente tipado autogenerado por Prisma ORM (se genera con `npx prisma generate`; no versionado).
* `openapi.yaml`: Contrato de las interfaces síncronas del módulo y catálogo de esquemas de eventos (RNF-03).
* `docker-compose.yml`: Definición del contenedor OCI de PostgreSQL (RNF-04).
* `.env.example`: Plantilla de variables de entorno requeridas (RNF-06).
* `prisma.config.ts` y `tsconfig.json`: Configuración de Prisma y del compilador TypeScript.

---

## Guía de Instalación y Ejecución Local (RNF-04 y RNF-06)

### Prerrequisitos
* **Node.js** (v18 o superior)
* **Docker y Docker Compose** (para ejecutar el motor PostgreSQL)

### Paso a paso

1. **Clonar el repositorio e instalar dependencias:**
   ```bash
   git clone <URL_DEL_REPOSITORIO>
   cd 2026-12-TPI
   npm install
   ```

2. **Configurar las variables de entorno (RNF-06):**
   Crear un archivo `.env` en la raíz copiando el contenido de `.env.example`:
   ```env
   POSTGRES_USER=m6user
   POSTGRES_PASSWORD=cambiar_esta_clave
   POSTGRES_DB=m6_trips
   DATABASE_URL="postgresql://m6user:cambiar_esta_clave@localhost:5433/m6_trips?schema=public"
   ```

3. **Levantar la base de datos PostgreSQL con Docker (RNF-04):**
   ```bash
   docker compose up -d
   ```

4. **Generar el cliente de Prisma y aplicar las migraciones en la base de datos:**
   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```

5. **(Opcional) Explorar las tablas visualmente con Prisma Studio:**
   ```bash
   npx prisma studio
   ```
