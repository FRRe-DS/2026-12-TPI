-- CreateEnum
CREATE TYPE "cancellation_reason" AS ENUM ('CHANGE_OF_PLANS', 'EXCESSIVE_DELAY', 'DRIVER_NO_SHOW', 'CLIENT_NO_SHOW', 'VEHICLE_PROBLEM', 'ORIGIN_UNREACHABLE', 'SECURITY_INCIDENT', 'ADMINISTRATIVE_BLOCK', 'OTHER');

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "cancellation_detail" TEXT,
ADD COLUMN     "cancellation_reason" "cancellation_reason",
ADD COLUMN     "cancelled_from_state" "trip_state",
ADD COLUMN     "requires_redispatch" BOOLEAN;
