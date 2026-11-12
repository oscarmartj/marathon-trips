-- Task 3.1: the payments core against the simulator. Plan docs/plans/3.1-payment-provider-core.md. Money is parked:
-- no ledger, refunds, disputes, receipts, GST, FX or supplier payments. Test-mode accounts only (CHECK below).

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('test', 'live');

-- CreateEnum
CREATE TYPE "ProviderAccountStatus" AS ENUM ('active', 'paused', 'retired', 'archived');

-- CreateEnum
CREATE TYPE "PaymentScheduleItemKind" AS ENUM ('deposit', 'balance', 'instalment', 'adjustment');

-- CreateEnum
CREATE TYPE "PaymentScheduleItemState" AS ENUM ('active', 'waived', 'superseded');

-- CreateEnum
CREATE TYPE "PaymentOrigin" AS ENUM ('collection', 'manual_intent', 'inbound');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'apple_pay', 'google_pay', 'payto', 'becs', 'payid_transfer', 'bpay', 'bnpl', 'manual_other');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('created', 'pending', 'requires_action', 'succeeded', 'failed', 'cancelled', 'expired', 'voided');

-- CreateEnum
CREATE TYPE "ProviderWebhookEventStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');

-- CreateEnum
CREATE TYPE "ProviderWebhookRejectionReason" AS ENUM ('bad_signature', 'stale_timestamp', 'malformed');

-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" UUID NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "status" "ProviderAccountStatus" NOT NULL DEFAULT 'active',
    "credentialsCiphertext" TEXT NOT NULL,
    "credentialsKeyVersion" INTEGER NOT NULL,
    "webhookSecretCiphertext" TEXT NOT NULL,
    "webhookKeyVersion" INTEGER NOT NULL,
    "webhookPathTokenHash" CHAR(64) NOT NULL,
    "lastConnectionTestAt" TIMESTAMPTZ(3),
    "lastConnectionTestResult" TEXT,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_schedules" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_schedule_items" (
    "id" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "kind" "PaymentScheduleItemKind" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "planVersion" INTEGER NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "dueDate" DATE NOT NULL,
    "state" "PaymentScheduleItemState" NOT NULL DEFAULT 'active',
    "supersededInVersion" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_schedule_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "origin" "PaymentOrigin" NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "targetScheduleItemId" UUID NOT NULL,
    "payerCustomerId" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "liveBookingId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "providerPaymentRef" TEXT,
    "failureCode" TEXT,
    "pendingExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "succeededAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "bookingId" UUID,
    "paymentId" UUID,
    "type" TEXT NOT NULL,
    "rawBody" BYTEA,
    "headers" JSONB NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ProviderWebhookEventStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMPTZ(3),
    "errorCode" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_rejections" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" "ProviderWebhookRejectionReason" NOT NULL,
    "bodySha256" CHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "claimedEventId" TEXT,
    "headers" JSONB NOT NULL,

    CONSTRAINT "webhook_rejections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_webhookPathTokenHash_key" ON "provider_accounts"("webhookPathTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_id_mode_key" ON "provider_accounts"("id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedules_bookingId_key" ON "payment_schedules"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedules_id_bookingId_currency_key" ON "payment_schedules"("id", "bookingId", "currency");

-- CreateIndex
CREATE INDEX "payment_schedule_items_bookingId_state_idx" ON "payment_schedule_items"("bookingId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedule_items_id_bookingId_currency_key" ON "payment_schedule_items"("id", "bookingId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedule_items_id_bookingId_key" ON "payment_schedule_items"("id", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedule_items_scheduleId_planVersion_sequence_key" ON "payment_schedule_items"("scheduleId", "planVersion", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "payments_liveBookingId_key" ON "payments"("liveBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_status_pendingExpiresAt_idx" ON "payments"("status", "pendingExpiresAt");

-- CreateIndex
CREATE INDEX "payments_payerCustomerId_idx" ON "payments"("payerCustomerId");

-- CreateIndex
CREATE INDEX "payments_targetScheduleItemId_idx" ON "payments"("targetScheduleItemId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_bookingId_currency_key" ON "payments"("id", "bookingId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_mode_key" ON "payments"("id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_bookingId_providerAccountId_mode_currency_key" ON "payments"("id", "bookingId", "providerAccountId", "mode", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "payments_bookingId_attemptNumber_key" ON "payments"("bookingId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerAccountId_providerPaymentRef_key" ON "payments"("providerAccountId", "providerPaymentRef");

-- CreateIndex
CREATE INDEX "webhook_events_status_receivedAt_idx" ON "webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "webhook_events_bookingId_idx" ON "webhook_events"("bookingId");

-- CreateIndex
CREATE INDEX "webhook_events_paymentId_idx" ON "webhook_events"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_providerAccountId_providerEventId_key" ON "webhook_events"("providerAccountId", "providerEventId");

-- CreateIndex
CREATE INDEX "webhook_rejections_receivedAt_idx" ON "webhook_rejections"("receivedAt");

-- CreateIndex
CREATE INDEX "webhook_rejections_providerAccountId_receivedAt_idx" ON "webhook_rejections"("providerAccountId", "receivedAt");

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_bookingId_currency_fkey" FOREIGN KEY ("bookingId", "currency") REFERENCES "bookings"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_schedule_items" ADD CONSTRAINT "payment_schedule_items_scheduleId_bookingId_currency_fkey" FOREIGN KEY ("scheduleId", "bookingId", "currency") REFERENCES "payment_schedules"("id", "bookingId", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bookingId_currency_fkey" FOREIGN KEY ("bookingId", "currency") REFERENCES "bookings"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_targetScheduleItemId_bookingId_currency_fkey" FOREIGN KEY ("targetScheduleItemId", "bookingId", "currency") REFERENCES "payment_schedule_items"("id", "bookingId", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payerCustomerId_fkey" FOREIGN KEY ("payerCustomerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_providerAccountId_mode_fkey" FOREIGN KEY ("providerAccountId", "mode") REFERENCES "provider_accounts"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "webhook_rejections" ADD CONSTRAINT "webhook_rejections_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---- Provider accounts: test mode only in 3.1; mode and adapter never change; never deleted ----
ALTER TABLE "provider_accounts"
  ADD CONSTRAINT "provider_accounts_test_mode_only_check" CHECK ("mode" = 'test'),
  ADD CONSTRAINT "provider_accounts_key_versions_check" CHECK ("credentialsKeyVersion" >= 1 AND "webhookKeyVersion" >= 1),
  ADD CONSTRAINT "provider_accounts_display_name_check" CHECK (char_length("displayName") BETWEEN 1 AND 100);
CREATE FUNCTION public.mt_provider_account_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a provider account is never deleted; retire or archive it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."mode" IS DISTINCT FROM OLD."mode" OR NEW."adapterKey" IS DISTINCT FROM OLD."adapterKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'the mode and adapter of a provider account never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER provider_accounts_guard BEFORE UPDATE OR DELETE ON "provider_accounts"
  FOR EACH ROW EXECUTE FUNCTION public.mt_provider_account_guard();
CREATE TRIGGER provider_accounts_no_truncate BEFORE TRUNCATE ON "provider_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Payment plans: never deleted; the version only goes up by one; an item is never edited, only superseded ----
ALTER TABLE "payment_schedules"
  ADD CONSTRAINT "payment_schedules_version_check" CHECK ("version" >= 1);
CREATE FUNCTION public.mt_payment_schedule_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment plan is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'the identity of a payment plan never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."version" <> OLD."version" + 1 AND NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'the version of a payment plan only goes up by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_schedules_guard BEFORE UPDATE OR DELETE ON "payment_schedules"
  FOR EACH ROW EXECUTE FUNCTION public.mt_payment_schedule_guard();
CREATE TRIGGER payment_schedules_no_truncate BEFORE TRUNCATE ON "payment_schedules"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

ALTER TABLE "payment_schedule_items"
  ADD CONSTRAINT "payment_schedule_items_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "payment_schedule_items_sequence_check" CHECK ("sequence" >= 1 AND "planVersion" >= 1),
  ADD CONSTRAINT "payment_schedule_items_state_check" CHECK (("state" = 'active') = ("supersededInVersion" IS NULL) AND ("supersededInVersion" IS NULL OR "supersededInVersion" > "planVersion"));
CREATE FUNCTION public.mt_payment_schedule_item_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment plan item is never deleted; supersede it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
     OR NEW."planVersion" IS DISTINCT FROM OLD."planVersion" OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'a payment plan item is never edited; supersede it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (OLD."state" = 'active' AND NEW."state" IN ('superseded', 'waived')) THEN
    RAISE EXCEPTION 'a payment plan item only goes from active to superseded or waived' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" = OLD."state" AND NEW."supersededInVersion" IS DISTINCT FROM OLD."supersededInVersion" THEN
    RAISE EXCEPTION 'a payment plan item only goes from active to superseded or waived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_schedule_items_guard BEFORE UPDATE OR DELETE ON "payment_schedule_items"
  FOR EACH ROW EXECUTE FUNCTION public.mt_payment_schedule_item_guard();
CREATE TRIGGER payment_schedule_items_no_truncate BEFORE TRUNCATE ON "payment_schedule_items"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- A booking that needs a plan has one, and its active items add up to what is owed (plan 0.1, P8): the booking total
-- from approval on, 0 once declined, expired, cancelled or refunded (no penalties before 6.4). A request has no plan.
-- Checked at commit, so the approval hook and the status change can happen in either order.
CREATE FUNCTION public.mt_payment_plan_matches_booking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  bid uuid;
  b record;
  has_plan boolean;
  owed bigint;
  active_sum bigint;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    bid := NEW."id";
  ELSE
    bid := NEW."bookingId";
  END IF;
  SELECT "status", "totalMinor" INTO b FROM public.bookings WHERE "id" = bid;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  has_plan := EXISTS (SELECT 1 FROM public.payment_schedules s WHERE s."bookingId" = bid);
  IF NOT has_plan THEN
    IF b."status" IN ('approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed') THEN
      RAISE EXCEPTION 'an approved booking has a payment plan' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  IF b."status" = 'requested' THEN
    RAISE EXCEPTION 'a booking request has no payment plan yet' USING ERRCODE = 'check_violation';
  END IF;
  owed := CASE WHEN b."status" IN ('approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed') THEN b."totalMinor" ELSE 0 END;
  SELECT COALESCE(sum(i."amountMinor"), 0) INTO active_sum FROM public.payment_schedule_items i WHERE i."bookingId" = bid AND i."state" = 'active';
  IF active_sum <> owed THEN
    RAISE EXCEPTION 'the active items of a payment plan must add up to what the booking owes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_payment_plan_matches AFTER UPDATE OF "status", "totalMinor" ON "bookings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_payment_plan_matches_booking();
CREATE CONSTRAINT TRIGGER payment_schedules_match_booking AFTER INSERT OR UPDATE ON "payment_schedules"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_payment_plan_matches_booking();
CREATE CONSTRAINT TRIGGER payment_schedule_items_match_booking AFTER INSERT OR UPDATE ON "payment_schedule_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_payment_plan_matches_booking();

-- ---- Payment attempts (plan 3.1, sections 3 and 5) ----
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "payments_origin_check" CHECK ("origin" = 'collection'),
  ADD CONSTRAINT "payments_attempt_check" CHECK ("attemptNumber" >= 1 AND "idempotencyKey" = 'booking:' || "bookingId"::text || ':attempt:' || "attemptNumber"::text),
  ADD CONSTRAINT "payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "payments_succeeded_check" CHECK (("status" <> 'succeeded' OR "providerPaymentRef" IS NOT NULL) AND (("status" = 'succeeded') = ("succeededAt" IS NOT NULL))),
  ADD CONSTRAINT "payments_live_check" CHECK (("status" IN ('created', 'requires_action', 'pending')) = ("liveBookingId" IS NOT NULL) AND ("liveBookingId" IS NULL OR "liveBookingId" = "bookingId"));
CREATE FUNCTION public.mt_payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'created' THEN
      RAISE EXCEPTION 'a payment attempt starts as created' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."origin" IS DISTINCT FROM OLD."origin" OR NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber"
     OR NEW."targetScheduleItemId" IS DISTINCT FROM OLD."targetScheduleItemId" OR NEW."payerCustomerId" IS DISTINCT FROM OLD."payerCustomerId"
     OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."adapterKey" IS DISTINCT FROM OLD."adapterKey" OR NEW."method" IS DISTINCT FROM OLD."method"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor" OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
     OR NEW."pendingExpiresAt" IS DISTINCT FROM OLD."pendingExpiresAt" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."providerPaymentRef" IS NOT NULL AND NEW."providerPaymentRef" IS DISTINCT FROM OLD."providerPaymentRef")
     OR (OLD."succeededAt" IS NOT NULL AND NEW."succeededAt" IS DISTINCT FROM OLD."succeededAt") THEN
    RAISE EXCEPTION 'the identity of a payment never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT ((OLD."status", NEW."status") IN (
      ('created'::"PaymentStatus", 'requires_action'::"PaymentStatus"), ('created', 'pending'), ('created', 'succeeded'), ('created', 'failed'), ('created', 'cancelled'), ('created', 'expired'),
      ('requires_action', 'pending'), ('requires_action', 'succeeded'), ('requires_action', 'failed'), ('requires_action', 'cancelled'), ('requires_action', 'expired'),
      ('pending', 'succeeded'), ('pending', 'failed'),
      ('failed', 'succeeded'), ('cancelled', 'succeeded'), ('expired', 'succeeded')
    )) THEN
      RAISE EXCEPTION 'payment status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'a change of payment status bumps its version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_guard BEFORE INSERT OR UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.mt_payment_guard();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON "payments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Webhook events: stored once per gateway event id; the body only goes to NULL; never deleted ----
ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "webhook_events_headers_check" CHECK (jsonb_typeof("headers") = 'object');
CREATE FUNCTION public.mt_webhook_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a webhook event is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
     OR NEW."providerEventId" IS DISTINCT FROM OLD."providerEventId" OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."headers" IS DISTINCT FROM OLD."headers" OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR (NEW."rawBody" IS DISTINCT FROM OLD."rawBody" AND NEW."rawBody" IS NOT NULL)
     OR (OLD."bookingId" IS NOT NULL AND NEW."bookingId" IS DISTINCT FROM OLD."bookingId")
     OR (OLD."paymentId" IS NOT NULL AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId") THEN
    RAISE EXCEPTION 'a webhook event is never edited, only matched and processed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_events_guard BEFORE UPDATE OR DELETE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION public.mt_webhook_event_guard();
CREATE TRIGGER webhook_events_no_truncate BEFORE TRUNCATE ON "webhook_events"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Webhook rejections: never edited; deleted only by the 30-day purge ----
ALTER TABLE "webhook_rejections"
  ADD CONSTRAINT "webhook_rejections_size_check" CHECK ("sizeBytes" >= 0),
  ADD CONSTRAINT "webhook_rejections_headers_check" CHECK (jsonb_typeof("headers") = 'object');
CREATE TRIGGER webhook_rejections_no_update BEFORE UPDATE ON "webhook_rejections"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();

-- Queues (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('payments.webhooks', '{"policy":"short","retryLimit":5,"retryDelay":30,"retryBackoff":true,"expireInSeconds":300,"deleteAfterSeconds":604800}'::jsonb);
SELECT pgboss.create_queue('payments.attempts', '{"policy":"short","retryLimit":5,"retryDelay":60,"retryBackoff":true,"expireInSeconds":300,"deleteAfterSeconds":604800}'::jsonb);
SELECT pgboss.create_queue('payments.maintenance', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
