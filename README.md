# Módulo M6: Viajes y Ciclo de Vida 
**Desarrollo de Software - 2026 | Grupo 12**

Repositorio correspondiente al **Módulo M6 (Viajes y Ciclo de Vida)** de la plataforma distribuida de movilidad urbana bajo demanda.

## Integrantes - Grupo 12
* Ayala Trangoni Malena Esperanza - Legajo: 27754
* Di Rado Luciano - Legajo: 26957
* Fankhauser Agostina - Legajo: 27311
* Kowtun Andrea - Legajo: 27049
* Montiel Lautaro - Legajo: 28810 
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

Cumpliendo con el principio de **propiedad de datos**, el Módulo M6 administra su propia base de datos **PostgreSQL** de forma autónoma mediante **Prisma ORM**. No se almacenan datos internos de perfiles ni tarifas, referenciando a otros dominios únicamente por sus identificadores (`UUID`).

En PostgreSQL, las tablas, columnas y enumeraciones están normalizadas bajo el estándar SQL **`snake_case`** (`trips`, `trip_event_history`), mapeadas de forma transparente a **`camelCase`** en TypeScript mediante las directivas `@@map` y `@map` de Prisma.

Existe una relación de **uno a muchos (`1:N`)** entre la cabecera del viaje (`Trip` / `trips`) y su historial de eventos (`TripEventHistory` / `trip_event_history`):

```mermaid
erDiagram
    TRIPS ||--o{ TRIP_EVENT_HISTORY : "registra (1:N)"

    TRIPS {
        uuid id PK
        uuid request_id UK "Idempotencia (M5)"
        uuid client_id "FK lógica (M2)"
        uuid driver_id "FK lógica (M3)"
        uuid vehicle_id "FK lógica (M3)"
        float origin_latitude
        float origin_longitude
        float destination_latitude
        float destination_longitude
        trip_state state "Default: PENDING_ARRIVAL"
        float distance_km "Nullable"
        int duration_minutes "Nullable"
        timestamp created_at
        timestamp updated_at
    }

    TRIP_EVENT_HISTORY {
        uuid id PK
        uuid trip_id FK "ON DELETE RESTRICT"
        trip_state state
        uuid actor_id "Nullable"
        actor_role actor_role
        string reason "Nullable"
        jsonb metadata "Nullable"
        timestamp created_at
    }
```

### 1. Tabla `trips` — Modelo `Trip` (Cabecera del viaje)
Almacena el estado vigente y los datos principales del viaje.

| Campo (Prisma) | Columna SQL (`snake_case`) | Tipo (PostgreSQL) | Restricciones | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `id` | `UUID` | `PK`, `NOT NULL`, `DEFAULT uuid()` | Identificador único del viaje generado automáticamente. |
| `requestId` | `request_id` | `UUID` | **`UNIQUE`**, `NOT NULL` | Identificador de la solicitud de despacho de M5 que originó el viaje (clave de idempotencia / RNF-09). |
| `clientId` | `client_id` | `UUID` | `NOT NULL`, `INDEX` | Identificador del cliente asociado al viaje. |
| `driverId` | `driver_id` | `UUID` | `NOT NULL`, `INDEX (driver_id, state)` | Identificador del conductor asignado por despacho (M5). |
| `vehicleId` | `vehicle_id` | `UUID` | `NOT NULL` | Identificador del vehículo asignado al viaje. |
| `originLatitude` | `origin_latitude` | `DOUBLE PRECISION` | `NOT NULL` | Latitud del punto de origen (`-90` a `90`). |
| `originLongitude` | `origin_longitude` | `DOUBLE PRECISION` | `NOT NULL` | Longitud del punto de origen (`-180` a `180`). |
| `destinationLatitude` | `destination_latitude` | `DOUBLE PRECISION` | `NOT NULL` | Latitud del punto de destino (`-90` a `90`). |
| `destinationLongitude` | `destination_longitude` | `DOUBLE PRECISION` | `NOT NULL` | Longitud del punto de destino (`-180` a `180`). |
| `state` | `state` | `trip_state (ENUM)` | `NOT NULL`, `DEFAULT 'PENDING_ARRIVAL'` | Estado vigente dentro de la máquina de estados. |
| `distanceKm` | `distance_km` | `DOUBLE PRECISION` | `NULLABLE` | Distancia recorrida en kilómetros registrada al finalizar (RF-6.5). |
| `durationMinutes` | `duration_minutes` | `INTEGER` | `NULLABLE` | Duración del viaje en minutos registrada al finalizar (RF-6.5). |
| `createdAt` | `created_at` | `TIMESTAMP(3)` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Fecha y hora de creación del viaje. |
| `updatedAt` | `updated_at` | `TIMESTAMP(3)` | `NOT NULL` (Auto-actualizado) | Fecha y hora de la última modificación de la fila. |

### 2. Tabla `trip_event_history` — Modelo `TripEventHistory` (Auditoría inmutable - RF-6.8)
Funciona como un registro *append-only* (solo inserción). Los registros existentes nunca se modifican ni se eliminan; cada transición agrega una nueva fila para mantener trazabilidad completa.

| Campo (Prisma) | Columna SQL (`snake_case`) | Tipo (PostgreSQL) | Restricciones | Descripción |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `id` | `UUID` | `PK`, `NOT NULL`, `DEFAULT uuid()` | Identificador único del evento de auditoría. |
| `tripId` | `trip_id` | `UUID` | `FK` (`trips.id`, `ON DELETE RESTRICT`), `NOT NULL` | Referencia al viaje al que pertenece el evento. |
| `state` | `state` | `trip_state (ENUM)` | `NOT NULL` | Estado al que transicionó el viaje con este evento. |
| `actorId` | `actor_id` | `UUID` | `NULLABLE` | Identificador del usuario que ejecutó la acción (`null` cuando actúa `SYSTEM`). |
| `actorRole` | `actor_role` | `actor_role (ENUM)` | `NOT NULL` | Rol del actor que ejecutó la acción (`CLIENT`, `DRIVER`, `OPERATOR`, `SYSTEM`). |
| `reason` | `reason` | `TEXT` | `NULLABLE` (Obligatorio en cancelaciones) | Motivo justificado de la cancelación (RF-6.6 / RF-6.7). |
| `metadata` | `metadata` | `JSONB` | `NULLABLE` | Datos adicionales estructurados (ej. `distanceKm` y `durationMinutes` al finalizar). |
| `createdAt` | `created_at` | `TIMESTAMP(3)` | `NOT NULL`, `DEFAULT CURRENT_TIMESTAMP` | Marca temporal exacta de la transición. |

### 3. Índices y Enumeraciones (PostgreSQL)
| Elemento | Nombre en PostgreSQL | Definición / Valores | Propósito |
| :--- | :--- | :--- | :--- |
| **Enum `TripState`** | `trip_state` | `PENDING_ARRIVAL`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED_BY_CLIENT`, `CANCELLED_BY_DRIVER` | Estado del viaje (`trips.state` y `trip_event_history.state`). |
| **Enum `ActorRole`** | `actor_role` | `CLIENT`, `DRIVER`, `OPERATOR`, `SYSTEM` | Rol del actor de cada transición (`trip_event_history.actor_role`). |
| **Unique Index** | `trips_request_id_key` | `UNIQUE (request_id)` | Garantiza idempotencia evitando viajes duplicados ante reintentos de M5 (RNF-08 / RNF-09). |
| **Index** | `trips_client_id_idx` | `INDEX (client_id)` | Optimiza la consulta de historial de viajes por cliente (`GET /trips?clientId=...`). |
| **Composite Index** | `trips_driver_id_state_idx` | `INDEX (driver_id, state)` | Optimiza la búsqueda de viajes activos o históricos de un conductor. |
| **Composite Index** | `trip_event_history_trip_id_created_at_idx` | `INDEX (trip_id, created_at)` | Optimiza la lectura ordenada cronológicamente de la auditoría (`GET /trips/{id}/history`). |

---

## Contratos e Integraciones con Otros Módulos (RNF-03)

### Entradas Síncronas (API REST Expuesta)
La especificación detallada de los endpoints se encuentra definida bajo el estándar **OpenAPI 3.0**.

| Método | Ruta | Rol / Origen | Acción / Transición |
| :--- | :--- | :--- | :--- |
| `POST` | `/trips` | **M5 (Despacho)** | Crea el viaje inicial en estado `PENDING_ARRIVAL`. |
| `GET` | `/trips?clientId={id}` | **M2 (Clientes)** / `CLIENT` | Consulta el historial resumido de viajes del cliente (RF-2.4). |
| `GET` | `/trips/{id}` | `CLIENT`, `DRIVER`, `OPERATOR` | Consulta el estado actual y resumen del viaje (RF-6.2). |
| `POST` | `/trips/{id}/arrived` | `DRIVER` | Registra arribo en punto de retiro (`DRIVER_ARRIVED` - RF-6.3). |
| `POST` | `/trips/{id}/start` | `DRIVER` (Valida con **M8**) | Valida QR de un solo uso e inicia viaje (`IN_PROGRESS` - RF-6.4). |
| `POST` | `/trips/{id}/complete` | `DRIVER` | Cierra el viaje con km y tiempo (`COMPLETED` - RF-6.5). |
| `POST` | `/trips/{id}/cancel` | `CLIENT` / `DRIVER` | Cancela el viaje registrando el motivo obligatorio (RF-6.6 / RF-6.7). |
| `GET` | `/trips/{id}/history` | `OPERATOR` | Consulta el registro de auditoría de transiciones (RF-6.8). |

### Salidas Asíncronas (Eventos de Dominio Emitidos)
*(En próximas iteraciones se publicarán mediante RabbitMQ según RNF-10)*:
* **`DriverArrived`** $\rightarrow$ **M8 (Notificaciones):** Avisa al pasajero que el chofer llegó al punto de encuentro.
* **`TripStarted`** $\rightarrow$ **M8 (Notificaciones):** Notifica el inicio formal del viaje tras validar el QR.
* **`TripCompleted`** $\rightarrow$ **M7 (Pagos)** para cálculo y cobro de tarifa final; **M8** para emisión de comprobante PDF; **M2** y **M3** para habilitar la calificación cruzada (RF-2.5 / RF-3.7).
* **`TripCancelledByClient`** $\rightarrow$ **M7 (Pagos)** para evaluar cargo por cancelación según minutos transcurridos; **M8** para notificar al conductor.
* **`TripCancelledByDriver`** $\rightarrow$ **M5 (Despacho)** para devolver la solicitud a búsqueda de nuevo conductor; **M8** para notificar al cliente.

---

## Estructura del Repositorio

```text
2026-12-TPI/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma      # Modelos Trip y TripEventHistory para PostgreSQL
│   │   └── migrations/        # Historial de migraciones SQL versionadas
│   ├── src/                   # Código fuente del servidor y explorador de persistencia
│   ├── generated/prisma/      # Cliente tipado autogenerado por Prisma ORM (no versionado)
│   ├── package.json           # Dependencias y scripts del backend
│   ├── prisma.config.ts       # Configuración de Prisma ORM
│   └── tsconfig.json          # Configuración del compilador TypeScript
├── frontend/                  # Aplicación Frontend del módulo (próximas iteraciones)
├── docker-compose.yml         # Definición del contenedor OCI de PostgreSQL (RNF-04)
├── openapi.yaml               # Contrato de las interfaces síncronas del módulo (RNF-03)
└── .env.example               # Plantilla de variables de entorno requeridas (RNF-06)
```

---

## Guía de Instalación y Ejecución Local (RNF-04 y RNF-06)

### Prerrequisitos
* **Node.js** (v18 o superior)
* **Docker y Docker Compose** (para ejecutar el motor PostgreSQL)

### Paso a paso

1. **Clonar el repositorio:**
   ```bash
   git clone <URL_DEL_REPOSITORIO>
   cd 2026-12-TPI
   ```

2. **Configurar las variables de entorno (RNF-06):**
   Crear un archivo `.env` en la raíz (y en `backend/.env`) copiando el contenido de `.env.example`:
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

4. **Instalar dependencias del Backend, generar el cliente de Prisma y aplicar las migraciones:**
   ```bash
   cd backend
   npm install
   npx prisma generate
   npx prisma migrate dev
   ```

5. **(Opcional) Explorar las tablas y probar el ciclo de vida visualmente:**
   * **Panel Visual de Persistencia M6 (`http://localhost:3006`):**
     ```bash
     npm run explorer
     ```
   * **Prisma Studio (`http://localhost:5555`):**
     ```bash
     npx prisma studio
     ```

