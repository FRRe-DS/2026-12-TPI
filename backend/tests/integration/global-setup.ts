import { execSync } from "node:child_process";
import { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Se ejecuta una vez antes de todos los tests de integración:
 * 1) verifica que la base sea de tests (nombre terminado en `_test`),
 * 2) la crea si no existe,
 * 3) le aplica las migraciones (prisma migrate deploy).
 */
export default async function setup() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("Falta TEST_DATABASE_URL (la define vitest.integration.config.ts).");
  }

  const dbName = new URL(testUrl).pathname.replace(/^\//, "");
  if (!dbName.endsWith("_test") || !/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new Error(
      `Abortado: la base "${dbName}" no es una base de tests (su nombre debe terminar en "_test").`
    );
  }

  // Se conecta a la base de mantenimiento "postgres" para poder crear la de tests.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  try {
    const rows = await admin.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${dbName}) AS exists`;
    if (!rows[0]?.exists) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  try {
    execSync("npx prisma migrate deploy", {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: testUrl },
    });
  } catch (err: any) {
    throw new Error(
      "No se pudieron aplicar las migraciones a la base de tests:\n" +
        String(err?.stdout ?? "") +
        String(err?.stderr ?? "")
    );
  }
}