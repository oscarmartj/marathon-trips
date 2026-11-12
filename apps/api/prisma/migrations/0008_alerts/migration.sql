-- Task 5.3: opening alerts.

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('pending', 'confirmed', 'unsubscribed');

-- CreateTable
CREATE TABLE "alert_subscriptions" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "raceId" UUID NOT NULL,
    "editionId" UUID,
    "scope" TEXT NOT NULL,
    "customerId" UUID,
    "status" "AlertStatus" NOT NULL DEFAULT 'pending',
    "confirmTokenHash" TEXT,
    "confirmTokenExpiresAt" TIMESTAMPTZ(3),
    "confirmedAt" TIMESTAMPTZ(3),
    "unsubscribedAt" TIMESTAMPTZ(3),
    "lastNotifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alert_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alert_subscriptions_confirmTokenHash_key" ON "alert_subscriptions"("confirmTokenHash");

-- CreateIndex
CREATE INDEX "alert_subscriptions_raceId_status_idx" ON "alert_subscriptions"("raceId", "status");

-- CreateIndex
CREATE INDEX "alert_subscriptions_customerId_idx" ON "alert_subscriptions"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "alert_subscriptions_email_raceId_scope_key" ON "alert_subscriptions"("email", "raceId", "scope");

-- AddForeignKey
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The scope column is derived from the edition, so one address has one row per race or edition.
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_scope_matches_edition"
  CHECK ("scope" = CASE WHEN "editionId" IS NULL THEN 'race' ELSE 'edition:' || "editionId"::text END);

-- A confirmed row has a confirmation time; an unsubscribed row has an unsubscribe time.
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_status_times"
  CHECK (("status" <> 'confirmed' OR "confirmedAt" IS NOT NULL) AND ("status" <> 'unsubscribed' OR "unsubscribedAt" IS NOT NULL));
