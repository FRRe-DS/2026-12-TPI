-- Unificación de los estados de cancelación en CANCELLED + cancelled_by.
-- Todo va en una sola transacción: si algo falla, la base queda como estaba.

BEGIN;

-- 1) Columna nueva: quién ejecutó la cancelación.
ALTER TABLE "trips" ADD COLUMN "cancelled_by" "actor_role";

-- 2) Guardar el actor ANTES de tocar el estado, mientras los valores viejos todavía existen.
UPDATE "trips"
SET "cancelled_by" = CASE "state"::text
    WHEN 'CANCELLED_BY_CLIENT' THEN 'CLIENT'::"actor_role"
    WHEN 'CANCELLED_BY_DRIVER' THEN 'DRIVER'::"actor_role"
  END
WHERE "state"::text IN ('CANCELLED_BY_CLIENT', 'CANCELLED_BY_DRIVER');

-- 3) Tipo nuevo, con un solo estado de cancelación.
CREATE TYPE "trip_state_new" AS ENUM (
  'PENDING_ARRIVAL',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED'
);

-- 4) Convertir la columna de viajes traduciendo los valores viejos.
ALTER TABLE "trips" ALTER COLUMN "state" DROP DEFAULT;

ALTER TABLE "trips"
  ALTER COLUMN "state" TYPE "trip_state_new" USING (
    CASE "state"::text
      WHEN 'CANCELLED_BY_CLIENT' THEN 'CANCELLED'
      WHEN 'CANCELLED_BY_DRIVER' THEN 'CANCELLED'
      ELSE "state"::text
    END
  )::"trip_state_new";

-- 5) Lo mismo en el historial (RF-6.8).
ALTER TABLE "trip_event_history"
  ALTER COLUMN "state" TYPE "trip_state_new" USING (
    CASE "state"::text
      WHEN 'CANCELLED_BY_CLIENT' THEN 'CANCELLED'
      WHEN 'CANCELLED_BY_DRIVER' THEN 'CANCELLED'
      ELSE "state"::text
    END
  )::"trip_state_new";

-- 6) Reemplazar el tipo viejo por el nuevo.
ALTER TYPE "trip_state" RENAME TO "trip_state_old";
ALTER TYPE "trip_state_new" RENAME TO "trip_state";
DROP TYPE "trip_state_old";

ALTER TABLE "trips" ALTER COLUMN "state" SET DEFAULT 'PENDING_ARRIVAL';

COMMIT;