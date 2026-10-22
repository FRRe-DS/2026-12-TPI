/*
  Warnings:

  - You are about to drop the `Trip` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TripEventHistory` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "trip_state" AS ENUM ('PENDING_ARRIVAL', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_DRIVER');

-- CreateEnum
CREATE TYPE "actor_role" AS ENUM ('CLIENT', 'DRIVER', 'OPERATOR', 'SYSTEM');

-- DropForeignKey
ALTER TABLE "TripEventHistory" DROP CONSTRAINT "TripEventHistory_tripId_fkey";

-- DropTable
DROP TABLE "Trip";

-- DropTable
DROP TABLE "TripEventHistory";

-- DropEnum
DROP TYPE "ActorRole";

-- DropEnum
DROP TYPE "TripState";

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "origin_latitude" DOUBLE PRECISION NOT NULL,
    "origin_longitude" DOUBLE PRECISION NOT NULL,
    "destination_latitude" DOUBLE PRECISION NOT NULL,
    "destination_longitude" DOUBLE PRECISION NOT NULL,
    "state" "trip_state" NOT NULL DEFAULT 'PENDING_ARRIVAL',
    "distance_km" DOUBLE PRECISION,
    "duration_minutes" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_event_history" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "state" "trip_state" NOT NULL,
    "actor_id" UUID,
    "actor_role" "actor_role" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_event_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trips_request_id_key" ON "trips"("request_id");

-- CreateIndex
CREATE INDEX "trips_client_id_idx" ON "trips"("client_id");

-- CreateIndex
CREATE INDEX "trips_driver_id_state_idx" ON "trips"("driver_id", "state");

-- CreateIndex
CREATE INDEX "trip_event_history_trip_id_created_at_idx" ON "trip_event_history"("trip_id", "created_at");

-- AddForeignKey
ALTER TABLE "trip_event_history" ADD CONSTRAINT "trip_event_history_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
