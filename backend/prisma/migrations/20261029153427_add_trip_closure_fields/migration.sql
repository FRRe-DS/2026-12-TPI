-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "duration_seconds" INTEGER,
ADD COLUMN     "final_latitude" DOUBLE PRECISION,
ADD COLUMN     "final_longitude" DOUBLE PRECISION;
