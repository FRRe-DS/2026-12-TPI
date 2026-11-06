/*
  Warnings:

  - A unique constraint covering the columns `[trip_id,sequence]` on the table `trip_event_history` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `action` to the `trip_event_history` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sequence` to the `trip_event_history` table without a default value. This is not possible if the table is not empty.
  - Made the column `actor_id` on table `trip_event_history` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "trip_action" AS ENUM ('CREATE', 'REGISTER_ARRIVAL', 'START', 'COMPLETE', 'CANCEL');

-- AlterTable
ALTER TABLE "trip_event_history" ADD COLUMN     "action" "trip_action" NOT NULL,
ADD COLUMN     "detail" TEXT,
ADD COLUMN     "from_state" "trip_state",
ADD COLUMN     "sequence" INTEGER NOT NULL,
ALTER COLUMN "actor_id" SET NOT NULL,
ALTER COLUMN "actor_id" SET DATA TYPE TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "trip_event_history_trip_id_sequence_key" ON "trip_event_history"("trip_id", "sequence");
