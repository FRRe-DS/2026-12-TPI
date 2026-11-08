-- CreateEnum
CREATE TYPE "rating_author" AS ENUM ('CLIENT', 'DRIVER');

-- CreateTable
CREATE TABLE "trip_ratings" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "rated_by" "rating_author" NOT NULL,
    "rater_id" UUID NOT NULL,
    "rated_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_ratings_trip_id_rated_by_key" ON "trip_ratings"("trip_id", "rated_by");

-- AddForeignKey
ALTER TABLE "trip_ratings" ADD CONSTRAINT "trip_ratings_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
