/*
  Warnings:

  - You are about to drop the `trip_ratings` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "trip_ratings" DROP CONSTRAINT "trip_ratings_trip_id_fkey";

-- DropTable
DROP TABLE "trip_ratings";

-- DropEnum
DROP TYPE "rating_author";
