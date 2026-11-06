-- CreateEnum
CREATE TYPE "vehicle_type" AS ENUM ('CAR', 'MOTORCYCLE');

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "destination_address" TEXT,
ADD COLUMN     "origin_address" TEXT,
ADD COLUMN     "reservation_id" UUID,
ADD COLUMN     "vehicle_type" "vehicle_type" NOT NULL DEFAULT 'CAR';