-- Renombra los valores del enum para alinearlos con M2, M3, M4, M8 y M9 (AUTO / MOTO).
-- RENAME VALUE conserva las filas que ya existen: CAR pasa a AUTO y MOTORCYCLE a MOTO.
ALTER TYPE "vehicle_type" RENAME VALUE 'CAR' TO 'AUTO';
ALTER TYPE "vehicle_type" RENAME VALUE 'MOTORCYCLE' TO 'MOTO';