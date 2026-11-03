FROM node:22-bookworm-slim

# Prisma necesita openssl
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# El servidor lee ../openapi.yaml y ../frontend, por eso se mantiene esta estructura
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci

COPY backend/ ./
COPY openapi.yaml /app/openapi.yaml
COPY frontend/ /app/frontend/

# prisma generate necesita DATABASE_URL definida, aunque no se conecte (valor ficticio solo para el build)
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

ENV PORT=3006
EXPOSE 3006

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3006/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Aplica las migraciones pendientes y arranca el servidor
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]