-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "arrived_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "started_at" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
