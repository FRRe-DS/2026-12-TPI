-- DropIndex
DROP INDEX "Trip_requestId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Trip_requestId_key" ON "Trip"("requestId");
