# M6 – Viajes y Ciclo de Vida (Grupo 12)

Persistencia del módulo M6: tablas `Trip` y `TripEventHistory` en PostgreSQL, manejadas con Prisma y TypeScript.

## Requisitos

- Node.js (LTS)
- Docker Desktop

## Cómo levantar la base de datos

1. Copiar `.env.example` a `.env` y completar la contraseña:

```bash
   copy .env.example .env
```

2. Instalar dependencias:

```bash
   npm install
```

3. Levantar PostgreSQL con Docker:

```bash
   docker compose up -d
```

4. Crear las tablas:

```bash
   npx prisma migrate dev
```

5. (Opcional) Ver las tablas en el navegador:

```bash
   npx prisma studio
```

## Estructura

- `prisma/schema.prisma`: definición de las tablas.
- `prisma/migrations/`: historial de cambios en la base.
- `docker-compose.yml`: PostgreSQL 16 en el puerto 5433.

## Tablas

- **Trip**: un registro por viaje, con su estado actual.
- **TripEventHistory**: historial de transiciones del viaje. Es solo de inserción: no se modifica ni se borra.