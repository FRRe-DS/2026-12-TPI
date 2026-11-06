import { defineConfig } from "vitest/config";

// `npm test`: solo tests unitarios (no necesitan Docker ni base de datos).
// Los de integración corren con `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
  },
});