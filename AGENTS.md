# AGENTS.md - Guia para cualquier IA que trabaje en este repositorio

Proyecto: **Modulo M6 "Viajes y Ciclo de Vida"** de una plataforma de movilidad urbana bajo demanda (tipo Uber). Materia TPI Desarrollo de Software 2026, **Grupo 12** (FRRe-DS/2026-12-TPI). Responde siempre en espanol.

Este archivo lo comparte todo el grupo, sin importar que IA use cada integrante. Las preferencias personales (nivel de detalle, tono, etc.) no van aca: cada persona se las indica a su IA por su cuenta.

## 1. Al empezar cada sesion (obligatorio)

1. Corre `git status` y `git --no-pager log --oneline -n 10` para ver la rama y el estado real del repo. No asumas el estado: leelo.
2. Lee `README.md`, sobre todo "Convenciones HTTP y cabeceras" y "Pendientes conocidos (deuda tecnica)". Si vas a tocar la API, lee tambien `openapi.yaml`.
3. Pregunta a la persona como se llama y que bloque o tema va a trabajar. Si no tiene ninguno asignado, propone el primero de los pendientes del README y espera su confirmacion. Antes de empezar, que confirme en el chat del grupo que nadie mas lo esta haciendo (mira tambien las ramas abiertas).
4. Si el bloque es una decision de diseno (no una tarea mecanica), explica las opciones con su trade-off y pregunta antes de elegir. Las decisiones abiertas son del equipo (seccion 10).
5. Antes de escribir codigo o tests nuevos, lee el codigo real involucrado (controller, service, mapper, tests existentes). No asumas como funciona.
6. Antes de ejecutar un comando que borre datos o reescriba historia, explica el riesgo y pedi confirmacion explicita (ver seccion 11).

## 2. Stack

- TypeScript sobre Node 22.12 o superior, con el modulo `http` nativo (**sin framework**).
- Prisma 6 + PostgreSQL 16 en Docker Compose (puerto **5433** desde la maquina local).
- Vitest para tests.
- Contrato de la API: `openapi.yaml` (raiz), unificado con el Grupo 5. **Ante cualquier diferencia entre contrato y codigo, manda el contrato.**

## 3. Arquitectura

Capas en `backend/src/`: `routes` -> `controllers` -> `services` -> `repositories` (Prisma).

- `domain/`: maquina de estados y reglas de cancelacion (logica pura, sin base de datos).
- `mappers/`: convierten filas de la base a los esquemas del contrato.
- `middlewares/`: autenticacion, errores, precondiciones (`If-Match`) y limite de pedidos.
- `config/services.ts`: armado de dependencias (wiring). `config/database.ts`: conexion.
- `explorer.ts`: arranque del servidor (puerto 3006; panel de demo en `/`, Swagger en `/docs`).
- `backend/prisma/schema.prisma` y `backend/prisma/migrations/`: modelo y migraciones.
- `backend/generated/prisma/`: cliente generado. **No se edita ni se versiona** (esta en `.gitignore`).
- `frontend/`: panel de demo (`index.html`) y Swagger UI (`swagger.html`), que sirve `explorer.ts`. Son archivos estaticos sin `package.json` ni build propio. Solo para desarrollo.

## 4. Puesta en marcha desde cero

```powershell
# 1. Variables de entorno (nunca se commitean)
copy .env.example .env
copy backend\.env.example backend\.env

# 2. Dependencias y base
docker compose up -d db
cd backend
npm install
npx prisma migrate deploy
npx prisma generate

# 3. Servidor
npm run dev
```

Comprobacion: `curl.exe -i http://localhost:3006/health/details` debe responder `200` con `components.postgres.status: "OK"`.

El `.env` de la raiz lo usa Docker Compose (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`). El de `backend/` lo usa la aplicacion (`DATABASE_URL` apuntando a `localhost:5433`). El contenedor del backend reemplaza esa URL por `db:5432`.

## 5. Comandos

Los comandos estan pensados para PowerShell en Windows (en otros shells, `curl.exe` pasa a ser `curl`).

| Para que | Comando | Desde |
| :--- | :--- | :--- |
| Levantar solo PostgreSQL | `docker compose up -d db` | raiz |
| Levantar base + backend en contenedor | `docker compose up -d --build` | raiz |
| Ver logs del backend en contenedor | `docker logs m6-backend --tail 50` | raiz |
| Servidor en desarrollo | `npm run dev` | `backend` |
| Chequear tipos | `npx tsc --noEmit` | `backend` |
| Tests unitarios (sin Docker) | `npm test` | `backend` |
| Un solo archivo de tests unitarios | `npx vitest run tests/health.test.ts` | `backend` |
| Tests de integracion (necesitan la base) | `npm run test:integration` | `backend` |
| Un solo archivo de integracion | `npx vitest run --config vitest.integration.config.ts tests/integration/health-and-auth.test.ts` | `backend` |
| Estado de las migraciones | `npx prisma migrate status` | `backend` |
| Aplicar migraciones pendientes | `npx prisma migrate deploy` | `backend` |
| Probar la API | `curl.exe -i http://localhost:3006/health/details` | cualquiera |

## 6. Problemas conocidos

- **`npx prisma` no encuentra Prisma y ofrece descargar la version 7.x**: se ejecuto fuera de `backend`. Entra a `backend` antes de cualquier comando de Prisma. Nunca aceptes instalar otra version mayor: el proyecto usa Prisma 6.
- **Error 500 "Can't reach database server"** (tambien al correr tests de integracion): falta abrir Docker Desktop y correr `docker compose up -d db`.
- **`EADDRINUSE` al hacer `npm run dev`**: el contenedor `m6-backend` ocupa el puerto 3006. Se libera con `docker compose stop backend`, o se usa otro puerto con `$env:PORT=3007; npm run dev`.
- **El contenedor corre con el codigo con el que se construyo**: para actualizarlo hay que usar `--build`.
- **`docker compose down` conserva los datos; `down -v` borra el volumen de la base.** Lo mismo con `prisma migrate reset`: borra los datos locales.
- **P3009 al aplicar migraciones**: hay una migracion que empezo y fallo. No se arregla con `migrate reset` a ciegas. Ver seccion 11.

## 7. Reglas de diseno que no se negocian

Salen del enunciado de la catedra. Si un pedido las contradice, avisa antes de implementarlo.

- **Propiedad de datos (RNF-05):** M6 es dueno solo de sus datos. De otros modulos guarda **solo referencias por ID** (`clientId`, `driverId`). Nunca copiar tablas ajenas ni consultar la base de otro modulo: los datos ajenos se piden por API o llegan por eventos.
- **Historial no destructivo (RF-6.8):** cada cambio de estado agrega una entrada (estado anterior, nuevo, actor, fecha, motivo). Nunca se modifica ni se borra lo anterior.
- **Transiciones controladas (RF-6.1):** toda transicion que no este permitida se rechaza con `409 INVALID_STATE_TRANSITION`.
- **Concurrencia (RNF-08):** ante pedidos simultaneos e incompatibles, solo uno gana. Debe impedirse la doble finalizacion y el doble cobro.
- **Idempotencia (RNF-09):** repetir la misma operacion o recibir dos veces el mismo mensaje no debe duplicar efectos. El `requestId` que llega de M5 se guarda y es unico.
- **Eventos (RNF-03):** se nombran en pasado ("viaje finalizado"), llevan datos suficientes para que quien los reciba no tenga que volver a preguntar, y se documentan en el catalogo de eventos del README, aparte de OpenAPI.
- **Resiliencia (RNF-13):** si un servicio externo falla o tarda, el comportamiento debe ser explicito, nunca un bloqueo indefinido. Las verificaciones de `/health/details` cortan a los 1,5 s y responden `503 DEPENDENCY_UNAVAILABLE`.
- **Privacidad (RNF-19):** no exponer datos sensibles, credenciales ni cadenas de conexion en respuestas, logs ni URLs.
- **Configuracion y secretos (RNF-06):** URLs, puertos y credenciales por variables de entorno, nunca en el repositorio.

## 8. Reglas del codigo

- Los errores salen **siempre** como `application/problem+json`, con un catalogo cerrado de `code`. No inventes codigos nuevos: el catalogo esta en `README.md` ("Convenciones HTTP y cabeceras") y en `openapi.yaml`.
- Las transiciones de estado solo pasan por la maquina de estados de `domain/`. El historial (`TripEventHistory`) es de solo insercion: nunca se modifica ni se borra.
- Tests unitarios en `backend/tests/*.test.ts` (no usan base). Tests de integracion en `backend/tests/integration/`, **un archivo por tema**, usando los helpers de `tests/integration/helpers.ts` y la base separada `m6_trips_test`.
- Los tests de integracion **no usan la base de desarrollo**: el `global-setup` crea `m6_trips_test` y le aplica las migraciones. Cada archivo resetea la base con `resetDatabase()`; no dependas del orden de ejecucion ni de datos de otro test.
- No subas `.env` ni secretos. `ENABLE_DEMO_AUTH` es solo para desarrollo y pruebas.
- No edites una migracion ya aplicada o publicada: crea una nueva con `npx prisma migrate dev --name <nombre>`.
- Explica a la persona cualquier cambio en `src/` antes de aplicarlo. **No hagas commit ni push por tu cuenta**: solo cuando la persona lo pida.

### Si cambias el comportamiento de la API

Ademas de actualizar `openapi.yaml` y el README en el **mismo bloque**, deja registrado **que cambio en el contrato**:

- **En `openapi.yaml`:** el cambio va en el esquema o la operacion correspondiente, con `info.version` actualizada si cambia la forma de consumirlo (`1.1.0` si agrega algo compatible, `2.0.0` si rompe).
- **En el cuerpo del commit** (varios `-m`): endpoint, que cambio (antes -> despues) y si es compatible o rompe a quien ya lo consume.
- **En el chat del grupo**, una linea: `Contrato: <endpoint> ahora <cambio>`. El README y `openapi.yaml` son la referencia; el aviso es para que nadie programe contra el comportamiento viejo.
- Si **rompe compatibilidad** (campo o valor de enum que desaparece, campo nuevo obligatorio, cambio de codigo de error o de estado HTTP): avisar en el chat y coordinarlo con el **G5** y con los modulos afectados antes de mergear. El contrato no se cambia en silencio.

Cuenta como cambio de contrato: endpoint nuevo, campo o enum nuevo o eliminado, nuevo `code` de error, cabecera nueva, validacion mas estricta, o cambio de semantica de un campo (aunque el tipo no cambie).

Ejemplo de commit:

```powershell
git commit -m "feat(trips): bloque N - <tema>" `
  -m "Contrato: <METODO> <ruta> ahora <cambio>." `
  -m "Compatible: <si/no y por que>. Avisado a <modulo/grupo>."
```

## 9. Flujo de trabajo

- **Un bloque por vez, un commit por bloque.**
- Ramas: `m6/<nombre>/<tema>` (por ejemplo `m6/luciano/vehicle-type-auto-moto`).
- Mensajes de commit **sin tildes ni enie** (PowerShell las rompe), con varios `-m` si hace falta explicar. Estilos usados:
  - `Bloque 10b(tests): creacion y consulta de viajes`
  - `feat(x): bloque N - descripcion`
- No trabajar directo sobre una rama compartida (`m6/base-de-datos`, `1erAdaptacion-nuevo-contrato`): crear una rama propia y unir por pull request con revision de otra persona.

### Checklist antes de cada commit

1. Todos los archivos guardados.
2. `npx tsc --noEmit` sin errores (desde `backend`).
3. `npm test` en verde.
4. `npm run test:integration` en verde (con la base levantada).
5. Si cambio la API: `openapi.yaml` y README actualizados, y el cambio de contrato explicado en el commit (seccion 8).
6. Decirle a la persona la **lista exacta** de archivos que deberian aparecer en `git status --short` (nuevos y modificados), para detectar si se colo algo. Ojo: `git status --short` junta las carpetas nuevas en una sola linea (`?? carpeta/`); `git status` las lista una por una.
7. Revisar `git --no-pager diff --stat`.

## 10. Decisiones abiertas (son del equipo, no las resuelvas solo)

Si la tarea toca alguna de estas, marcala como decision pendiente, explica las opciones y recorda que hay que acordarla con el grupo y documentarla en el README (RNF-20):

1. Quien valida el QR de inicio del viaje: M6 o M8, que lo genera.
2. Si se puede cancelar un viaje ya iniciado. #resuelta
3. Si el operador puede cancelar viajes. #resuelta
4. Si se guardan origen y destino como copia (instantanea) en M6, y con que justificacion.
5. Si M6 controla que la distancia informada por el conductor sea razonable, y si eso implica una dependencia opcional con M4.
6. Como se valida el token de Keycloak: localmente o consultando a M1.
7. Quien levanta Keycloak en el entorno de desarrollo.
8. Alcance exacto de cada entrega.

## 11. Migraciones de Prisma

Cuando una rama trae una migracion nueva, **avisar al grupo**. Para actualizar una base que ya existe (conserva los datos), desde `backend`:

```powershell
npx prisma migrate deploy
npx prisma generate
```

`npx prisma migrate reset` **borra todos los datos locales**: usalo solo si hay *drift* (la base no coincide con el historial) y con confirmacion explicita de la persona.

Si aparece **P3009** ("migrate found failed migrations"):

1. No corras `reset` por reflejo.
2. Lee el registro de la migracion fallida:

```powershell
docker exec m6-postgres psql -U m6user -d m6_trips -c "SELECT migration_name, started_at, finished_at, rolled_back_at, logs FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5"
```

3. Revisa si la migracion dejo cambios a medias en la base.
4. Decide con la persona: marcar el intento como deshecho (`npx prisma migrate resolve --rolled-back <nombre>`) y reintentar, o recrear la base si los datos son de prueba.

## 12. Cuando te pasen la salida de tests o de git

Si la persona te pega la salida de `npm test`, `npm run test:integration` o `git status`, no te limites a decir si paso. Revisa el repo y decile si el cambio esta bien hecho o si falta algo.

## 13. Pendientes conocidos

Estan en el `README.md`, seccion "Pendientes conocidos (deuda tecnica)". No los inventes ni los reordenes: si la persona no sabe que sigue, propone el primero de esa lista y espera confirmacion.
