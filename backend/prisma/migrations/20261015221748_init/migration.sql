-- CreateEnum
CREATE TYPE "TripState" AS ENUM ('PENDING_ARRIVAL', 'DRIVER_ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED_BY_CLIENT', 'CANCELLED_BY_DRIVER');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('AUTO', 'MOTO');

-- CreateEnum
CREATE TYPE "ActorRole" AS ENUM ('CLIENT', 'DRIVER', 'OPERATOR', 'SYSTEM');

-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "state" "TripState" NOT NULL DEFAULT 'PENDING_ARRIVAL',
    "distanceKm" DOUBLE PRECISION,
    "durationMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TripEventHistory" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "state" "TripState" NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" "ActorRole" NOT NULL,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripEventHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trip_requestId_idx" ON "Trip"("requestId");

-- CreateIndex
CREATE INDEX "Trip_clientId_idx" ON "Trip"("clientId");

-- CreateIndex
CREATE INDEX "Trip_driverId_state_idx" ON "Trip"("driverId", "state");

-- CreateIndex
CREATE INDEX "TripEventHistory_tripId_createdAt_idx" ON "TripEventHistory"("tripId", "createdAt");

-- AddForeignKey
ALTER TABLE "TripEventHistory" ADD CONSTRAINT "TripEventHistory_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
