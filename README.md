# Módulo M6: Viajes y Ciclo de Vida 🚗🛵
**Desarrollo de Software - 2026 | Grupo 12**

Repositorio correspondiente al **Módulo M6 (Viajes y Ciclo de Vida)** de la plataforma distribuida de movilidad urbana bajo demanda.

## Integrantes - Grupo 12
* [Di Rado Luciano] - Legajo: [26957]
* [Pozzer Maurizio] - Legajo: [27420]
* [Vignoles Francisco] - Legajo: [27259]
* (agregar los nombres y legajos restantes)

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
| `id` | `UUID (String)` | `PK`, No nulo | Identificador único del viaje generado automáticamente. |
| `clientId` | `String` | No nulo | Identificador del cliente asociado al viaje. |
| `driverId` | `String` | No nulo | Identificador del conductor asignado por despacho (M5). |
| `origin` | `String` | No nulo | Coordenadas o dirección del punto de origen. |
| `destination` | `String` | No nulo | Coordenadas o dirección del destino final. |
| `state` | `String / Enum` | No nulo (Default: `PENDING_ARRIVAL`) | Estado vigente dentro de la máquina de estados. |
| `createdAt` | `DateTime` | No nulo (Default: `now()`) | Fecha y hora de creación del viaje. |
| `updatedAt` | `DateTime` | No nulo | Fecha y hora de la última transición registrada. |

### 2. Tabla `TripEventHistory` (Auditoría inmutable - RF-6.8)
Funciona como un registro *append-only* (solo inserción). Los registros existentes nunca se modifican ni se eliminan; cada transición agrega una nueva fila para mantener trazabilidad completa.

| Campo | Tipo | Restricciones | Descripción |
| :--- | :--- | :--- | :--- |
| `id` | `UUID (String)` | `PK`, No nulo | Identificador único del evento de auditoría. |
| `tripId` | `UUID (String)` | `FK` (`Trip.id`), No nulo | Referencia al viaje al que pertenece el evento. |
| `state` | `String / Enum` | No nulo | Nuevo estado al que transicionó el viaje. |
| `actor` | `String` | No nulo | Rol e identificador del usuario o sistema que ejecutó la acción. |
| `reason` | `String` | Nullable (Obligatorio en cancelaciones) | Motivo justificado de la cancelación (RF-6.6 / RF-6.7). |
| `metadata` | `JSON` | Nullable | Datos adicionales estructurados (ej. `distanceKm` y `timeMinutes` al finalizar). |
| `createdAt` | `DateTime` | No nulo (Default: `now()`) | Marca temporal exacta de la transición. |

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
* **`TripCompleted`** $\rightarrow$ **M7 (Pagos)** para cálculo y cobro de tarifa final; **M8** para emisión de comprobante PDF; **M3** para habilitar calificación.
* **`TripCancelledByClient`** $\rightarrow$ **M7 (Pagos)** para evaluar cargo por cancelación según minutos transcurridos; **M8** para notificar al conductor.
* **`TripCancelledByDriver`** $\rightarrow$ **M5 (Despacho)** para devolver la solicitud a búsqueda de nuevo conductor; **M8** para notificar al cliente.

---

## Estructura del Repositorio

* `prisma/schema.prisma`: Definición de los modelos `Trip` y `TripEventHistory` para PostgreSQL.
* `prisma/migrations/`: Historial de migraciones SQL versionadas.
* `generated/prisma/`: Cliente tipado autogenerado por Prisma ORM.
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