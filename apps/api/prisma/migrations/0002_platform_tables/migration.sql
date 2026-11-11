-- Task 0.4: flags, settings, outbox events, idempotency, stored files, outbound email, sequences.

-- CreateEnum
CREATE TYPE "EventDeliveryStatus" AS ENUM ('pending', 'done', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('in_progress', 'completed');

-- CreateEnum
CREATE TYPE "FileVisibility" AS ENUM ('private', 'public');

-- CreateEnum
CREATE TYPE "OutboundEmailStatus" AS ENUM ('queued', 'sent', 'failed', 'suppressed');

-- CreateEnum
CREATE TYPE "MailCategory" AS ENUM ('transactional', 'marketing');

-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('unsubscribed', 'bounced', 'complaint');

-- CreateEnum
CREATE TYPE "EmailSuppressionScope" AS ENUM ('marketing', 'all');

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "aggregateVersion" INTEGER,
    "payload" JSONB NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" UUID,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_deliveries" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "status" "EventDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'in_progress',
    "responseStatus" INTEGER,
    "errorCode" TEXT,
    "resourceType" TEXT,
    "resourceId" UUID,
    "lockedUntil" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "originalName" TEXT,
    "visibility" "FileVisibility" NOT NULL DEFAULT 'private',
    "purpose" TEXT NOT NULL,
    "uploadedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_emails" (
    "id" UUID NOT NULL,
    "to" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "bodySha256" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "category" "MailCategory" NOT NULL DEFAULT 'transactional',
    "status" "OutboundEmailStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "customerId" UUID,
    "relatedEntityType" TEXT,
    "relatedEntityId" UUID,
    "error" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" UUID NOT NULL,
    "emailHash" TEXT NOT NULL,
    "emailHashKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "reason" "EmailSuppressionReason" NOT NULL,
    "scope" "EmailSuppressionScope" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "number_sequences" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "nextValue" BIGINT NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE UNIQUE INDEX "settings_key_key" ON "settings"("key");

-- CreateIndex
CREATE INDEX "outbox_events_dispatchedAt_occurredAt_idx" ON "outbox_events"("dispatchedAt", "occurredAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_aggregateVersion_idx" ON "outbox_events"("aggregateType", "aggregateId", "aggregateVersion");

-- CreateIndex
CREATE INDEX "event_deliveries_status_consumer_idx" ON "event_deliveries"("status", "consumer");

-- CreateIndex
CREATE UNIQUE INDEX "event_deliveries_eventId_consumer_key" ON "event_deliveries"("eventId", "consumer");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scope_key_key" ON "idempotency_records"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_storageKey_key" ON "stored_files"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_emails_dedupeKey_key" ON "outbound_emails"("dedupeKey");

-- CreateIndex
CREATE INDEX "outbound_emails_status_createdAt_idx" ON "outbound_emails"("status", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_emails_relatedEntityType_relatedEntityId_idx" ON "outbound_emails"("relatedEntityType", "relatedEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_emailHash_key" ON "email_suppressions"("emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "number_sequences_key_key" ON "number_sequences"("key");

-- AddForeignKey
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Checks that Prisma cannot express (it ignores them when comparing).
ALTER TABLE "event_deliveries" ADD CONSTRAINT "event_deliveries_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_attempts_check" CHECK ("attempts" >= 0);
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_sizeBytes_check" CHECK ("sizeBytes" >= 0);
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_nextValue_check" CHECK ("nextValue" >= 1);
