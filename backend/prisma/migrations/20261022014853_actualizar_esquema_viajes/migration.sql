/*
  Warnings:

  - The primary key for the `Trip` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `destination` on the `Trip` table. All the data in the column will be lost.
  - You are about to drop the column `origin` on the `Trip` table. All the data in the column will be lost.
  - You are about to drop the column `vehicleType` on the `Trip` table. All the data in the column will be lost.
  - The primary key for the `TripEventHistory` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `actorId` column on the `TripEventHistory` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `destinationLatitude` to the `Trip` table without a default value. This is not possible if the table is not empty.
  - Added the required column `destinationLongitude` to the `Trip` table without a default value. This is not possible if the table is not empty.
  - Added the required column `originLatitude` to the `Trip` table without a default value. This is not possible if the table is not empty.
  - Added the required column `originLongitude` to the `Trip` table without a default value. This is not possible if the table is not empty.
  - Added the required column `vehicleId` to the `Trip` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `id` on the `Trip` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `requestId` on the `Trip` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `clientId` on the `Trip` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `driverId` on the `Trip` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `TripEventHistory` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `tripId` on the `TripEventHistory` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "TripEventHistory" DROP CONSTRAINT "TripEventHistory_tripId_fkey";

-- AlterTable
ALTER TABLE "Trip" DROP CONSTRAINT "Trip_pkey",
DROP COLUMN "destination",
DROP COLUMN "origin",
DROP COLUMN "vehicleType",
ADD COLUMN     "destinationLatitude" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "destinationLongitude" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "originLatitude" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "originLongitude" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "vehicleId" UUID NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "requestId",
ADD COLUMN     "requestId" UUID NOT NULL,
DROP COLUMN "clientId",
ADD COLUMN     "clientId" UUID NOT NULL,
DROP COLUMN "driverId",
ADD COLUMN     "driverId" UUID NOT NULL,
ADD CONSTRAINT "Trip_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "TripEventHistory" DROP CONSTRAINT "TripEventHistory_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "tripId",
ADD COLUMN     "tripId" UUID NOT NULL,
DROP COLUMN "actorId",
ADD COLUMN     "actorId" UUID,
ADD CONSTRAINT "TripEventHistory_pkey" PRIMARY KEY ("id");

-- DropEnum
DROP TYPE "VehicleType";

-- CreateIndex
CREATE UNIQUE INDEX "Trip_requestId_key" ON "Trip"("requestId");

-- CreateIndex
CREATE INDEX "Trip_clientId_idx" ON "Trip"("clientId");

-- CreateIndex
CREATE INDEX "Trip_driverId_state_idx" ON "Trip"("driverId", "state");

-- CreateIndex
CREATE INDEX "TripEventHistory_tripId_createdAt_idx" ON "TripEventHistory"("tripId", "createdAt");

-- AddForeignKey
ALTER TABLE "TripEventHistory" ADD CONSTRAINT "TripEventHistory_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
