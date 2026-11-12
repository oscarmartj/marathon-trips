-- Task 8.4: scoped API keys and signed outgoing webhooks (plan docs/plans/8.4-api-keys-outbound-webhooks.md).

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'sending', 'succeeded', 'failed', 'suppressed', 'cancelled');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "ownerUserId" UUID NOT NULL,
    "ownerKind" "UserKind" NOT NULL DEFAULT 'staff',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "url" TEXT NOT NULL,
    "eventTypes" TEXT[],
    "secretCiphertext" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "previousSecretCiphertext" TEXT,
    "previousKeyVersion" INTEGER,
    "previousExpiresAt" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMPTZ(3),
    "disabledReason" TEXT,
    "createdById" UUID NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "leaseUntil" TIMESTAMPTZ(3),
    "lastAttemptAt" TIMESTAMPTZ(3),
    "succeededAt" TIMESTAMPTZ(3),
    "lastResponseStatus" INTEGER,
    "lastDurationMs" INTEGER,
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_ownerUserId_idx" ON "api_keys"("ownerUserId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_nextAttemptAt_idx" ON "webhook_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_subscriptionId_eventId_key" ON "webhook_deliveries"("subscriptionId", "eventId");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_ownerUserId_ownerKind_fkey" FOREIGN KEY ("ownerUserId", "ownerKind") REFERENCES "users"("id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscriptions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---- Hand-written: CHECKs, triggers, grants and queues (not expressible in Prisma) ----

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_owner_is_staff" CHECK ("ownerKind" = 'staff'),
  ADD CONSTRAINT "api_keys_prefix_format" CHECK ("prefix" ~ '^[a-z2-7]{12}$'),
  ADD CONSTRAINT "api_keys_name_length" CHECK (char_length("name") BETWEEN 1 AND 80),
  ADD CONSTRAINT "api_keys_scopes_count" CHECK ("scopes" IS NOT NULL AND cardinality("scopes") BETWEEN 1 AND 50),
  ADD CONSTRAINT "api_keys_expiry_window" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '366 days'),
  ADD CONSTRAINT "api_keys_revoke_reason" CHECK ("revokeReason" IS NULL OR "revokeReason" IN ('manual', 'owner_disabled', 'owner_reset')),
  ADD CONSTRAINT "api_keys_revoked_together" CHECK (("revokedAt" IS NULL) = ("revokeReason" IS NULL));

ALTER TABLE "webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_url_length" CHECK (char_length("url") <= 2048),
  ADD CONSTRAINT "webhook_subscriptions_url_scheme" CHECK ("url" = '' OR "url" ~ '^https?://'),
  ADD CONSTRAINT "webhook_subscriptions_url_kept_until_deleted" CHECK ("url" <> '' OR "deletedAt" IS NOT NULL),
  ADD CONSTRAINT "webhook_subscriptions_event_types_count" CHECK ("eventTypes" IS NOT NULL AND cardinality("eventTypes") BETWEEN 1 AND 50),
  ADD CONSTRAINT "webhook_subscriptions_description_length" CHECK (char_length("description") <= 200),
  ADD CONSTRAINT "webhook_subscriptions_failures" CHECK ("consecutiveFailures" >= 0),
  ADD CONSTRAINT "webhook_subscriptions_disabled_reason" CHECK ("disabledReason" IS NULL OR "disabledReason" IN ('manual', 'consecutive_failures'));

ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_attempts" CHECK ("attempts" BETWEEN 0 AND 10);

-- An API key never changes after creation, except its name, last use and a one-way revocation (plan 8.4, section 2).
CREATE FUNCTION public.mt_api_keys_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."prefix" IS DISTINCT FROM OLD."prefix" OR NEW."secretHash" IS DISTINCT FROM OLD."secretHash"
     OR NEW."scopes" IS DISTINCT FROM OLD."scopes" OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" OR NEW."ownerKind" IS DISTINCT FROM OLD."ownerKind"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'api key columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" OR NEW."revokedById" IS DISTINCT FROM OLD."revokedById"
     OR NEW."revokeReason" IS DISTINCT FROM OLD."revokeReason") THEN
    RAISE EXCEPTION 'a revoked api key stays revoked' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mt_api_keys_guard() FROM PUBLIC;

CREATE TRIGGER api_keys_guard BEFORE UPDATE ON "api_keys"
  FOR EACH ROW EXECUTE FUNCTION public.mt_api_keys_guard();

-- Keys and subscriptions keep their history: the audit log points at them. Deliveries are purged after 30 days.
REVOKE DELETE, TRUNCATE ON "api_keys", "webhook_subscriptions" FROM mt_app;

-- Queues (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('webhooks.send', '{"policy":"short","retryLimit":2,"retryDelay":30,"retryBackoff":true,"expireInSeconds":120,"deleteAfterSeconds":604800}'::jsonb);
SELECT pgboss.create_queue('webhooks.maintenance', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
