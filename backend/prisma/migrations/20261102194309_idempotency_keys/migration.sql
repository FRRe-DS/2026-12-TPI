-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "response_etag" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_actor_id_key_key" ON "idempotency_keys"("actor_id", "key");
