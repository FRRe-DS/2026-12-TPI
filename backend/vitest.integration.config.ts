import "dotenv/config";
import { defineConfig } from "vitest/config";

/**
 * Calcula la URL de la base de tests: la misma de desarrollo pero con el nombre terminado en `_test`.
 * Se puede forzar con la variable TEST_DATABASE_URL.
 */
function resolveTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error("Falta DATABASE_URL (backend/.env): hace falta para calcular la base de tests.");
  }
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = "/" + (name.endsWith("_test") ? name : `${name}_test`);
  return url.toString();
}

const testDatabaseUrl = resolveTestDatabaseUrl();
// Lo lee global-setup.ts (corre en el proceso principal de Vitest).
process.env.TEST_DATABASE_URL = testDatabaseUrl;

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["./tests/integration/global-setup.ts"],
    // Todos los archivos comparten la misma base: se ejecutan de a uno.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 60_000,
    // Variables que ve el servidor mientras corren los tests (nunca la base de desarrollo).
    env: {
      DATABASE_URL: testDatabaseUrl,
      ENABLE_DEMO_AUTH: "true",
      NODE_ENV: "test",
    },
  },
});