import { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Instancia única (Singleton) de PrismaClient para gestionar el pool de conexiones a PostgreSQL.
 */
export const prisma = new PrismaClient();
