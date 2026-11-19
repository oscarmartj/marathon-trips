-- Task 3.4: the manual PayID transfer method. Plan docs/plans/3.4-manual-payid-transfer.md.
-- A manual method has a configuration row; a customer's promise to transfer is a `manual_intent` payment that never
-- holds the live-attempt slot and never succeeds; staff confirm the money as an `inbound` payment, which can be voided
-- and then confirmed again with the same bank reference. Test mode only (the provider-account CHECK of 0017 stays).

-- CreateEnum
CREATE TYPE "PayIdType" AS ENUM ('email', 'phone', 'abn', 'org_id');

-- CreateTable
CREATE TABLE "payment_method_configs" (
    "id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "countries" TEXT[],
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "instructions" JSONB,
    "payeeName" TEXT,
    "payIdType" "PayIdType",
    "payId" TEXT,
    "bsb" CHAR(6),
    "accountNumber" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_method_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_method_configs_method_key" ON "payment_method_configs"("method");

ALTER TABLE "payment_method_configs"
  ADD CONSTRAINT "payment_method_configs_method_check" CHECK ("method" IN ('payid_transfer', 'manual_other')),
  ADD CONSTRAINT "payment_method_configs_version_check" CHECK ("version" >= 0),
  ADD CONSTRAINT "payment_method_configs_bsb_check" CHECK ("bsb" IS NULL OR "bsb" ~ '^[0-9]{6}$'),
  ADD CONSTRAINT "payment_method_configs_payid_pair_check" CHECK (("payId" IS NULL) = ("payIdType" IS NULL)),
  ADD CONSTRAINT "payment_method_configs_bank_pair_check" CHECK (("bsb" IS NULL) = ("accountNumber" IS NULL)),
  ADD CONSTRAINT "payment_method_configs_enabled_check" CHECK (NOT "enabled" OR (
    cardinality("countries") >= 1 AND "payeeName" IS NOT NULL AND ("payId" IS NOT NULL OR "bsb" IS NOT NULL)));
CREATE TRIGGER payment_method_configs_no_delete BEFORE DELETE ON "payment_method_configs"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER payment_method_configs_no_truncate BEFORE TRUNCATE ON "payment_method_configs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
REVOKE DELETE ON "payment_method_configs" FROM mt_app;

-- ---- Payments: manual intents and confirmed transfers ----
ALTER TABLE "payments" ALTER COLUMN "targetScheduleItemId" DROP NOT NULL;
ALTER TABLE "payments" ADD COLUMN "payerReference" TEXT;

ALTER TABLE "payments"
  DROP CONSTRAINT "payments_origin_check",
  DROP CONSTRAINT "payments_attempt_check",
  DROP CONSTRAINT "payments_succeeded_check",
  DROP CONSTRAINT "payments_live_check";
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_target_check" CHECK ("origin" = 'inbound' OR "targetScheduleItemId" IS NOT NULL),
  ADD CONSTRAINT "payments_attempt_check" CHECK ("attemptNumber" >= 1 AND "idempotencyKey" = 'booking:' || "bookingId"::text || CASE WHEN "origin" = 'inbound' THEN ':inbound:' ELSE ':attempt:' END || "attemptNumber"::text),
  ADD CONSTRAINT "payments_succeeded_check" CHECK (("status" IN ('succeeded', 'voided')) = ("succeededAt" IS NOT NULL) AND ("status" NOT IN ('succeeded', 'voided') OR "providerPaymentRef" IS NOT NULL)),
  ADD CONSTRAINT "payments_live_check" CHECK (
    ("origin" = 'collection' AND ("status" IN ('created', 'requires_action', 'pending')) = ("liveBookingId" IS NOT NULL) AND ("liveBookingId" IS NULL OR "liveBookingId" = "bookingId"))
    OR ("origin" <> 'collection' AND "liveBookingId" IS NULL)),
  ADD CONSTRAINT "payments_manual_intent_check" CHECK ("origin" <> 'manual_intent' OR ("status" IN ('created', 'cancelled', 'expired') AND "providerPaymentRef" IS NULL)),
  ADD CONSTRAINT "payments_inbound_check" CHECK ("origin" <> 'inbound' OR ("status" IN ('created', 'succeeded', 'voided') AND "providerPaymentRef" IS NOT NULL AND "payerReference" IS NOT NULL)),
  ADD CONSTRAINT "payments_voided_check" CHECK ("status" <> 'voided' OR "origin" = 'inbound');

DROP INDEX "payments_providerAccountId_providerPaymentRef_key";
CREATE INDEX "payments_providerAccountId_providerPaymentRef_idx" ON "payments"("providerAccountId", "providerPaymentRef");
-- A bank movement is recorded once per account, until it is voided: then it can be confirmed again (plan 0.1, 5.5).
CREATE UNIQUE INDEX "payments_provider_ref_not_voided" ON "payments"("providerAccountId", "providerPaymentRef") WHERE "status" <> 'voided' AND "providerPaymentRef" IS NOT NULL;
-- One open manual intent per booking.
CREATE UNIQUE INDEX "payments_one_open_manual_intent" ON "payments"("bookingId") WHERE "origin" = 'manual_intent' AND "status" = 'created';

CREATE OR REPLACE FUNCTION public.mt_payment_guard() RETURNS trigger
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
     OR NEW."paymentLinkId" IS DISTINCT FROM OLD."paymentLinkId" OR NEW."payerReference" IS DISTINCT FROM OLD."payerReference"
     OR (OLD."providerPaymentRef" IS NOT NULL AND NEW."providerPaymentRef" IS DISTINCT FROM OLD."providerPaymentRef")
     OR (OLD."succeededAt" IS NOT NULL AND NEW."succeededAt" IS DISTINCT FROM OLD."succeededAt") THEN
    RAISE EXCEPTION 'the identity of a payment never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT ((OLD."status", NEW."status") IN (
      ('created'::"PaymentStatus", 'requires_action'::"PaymentStatus"), ('created', 'pending'), ('created', 'succeeded'), ('created', 'failed'), ('created', 'cancelled'), ('created', 'expired'),
      ('requires_action', 'pending'), ('requires_action', 'succeeded'), ('requires_action', 'failed'), ('requires_action', 'cancelled'), ('requires_action', 'expired'),
      ('pending', 'succeeded'), ('pending', 'failed'),
      ('failed', 'succeeded'), ('cancelled', 'succeeded'), ('expired', 'succeeded'),
      ('succeeded', 'voided')
    )) THEN
      RAISE EXCEPTION 'payment status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'voided' AND OLD."origin" <> 'inbound' THEN
      RAISE EXCEPTION 'only a confirmed transfer can be voided' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'a change of payment status bumps its version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Bookings: a deposit that is no longer covered (a voided transfer) reopens the approval ----
CREATE OR REPLACE FUNCTION public.mt_booking_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a booking is never deleted; cancel it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'requested' OR NEW."currentSnapshotVersion" <> 1 THEN
      RAISE EXCEPTION 'a booking starts as a request at snapshot 1' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.packages p WHERE p."id" = NEW."packageId" AND p."editionId" = NEW."editionId") THEN
      RAISE EXCEPTION 'a booking''s edition is its package''s edition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."packageId" IS DISTINCT FROM OLD."packageId" OR NEW."editionId" IS DISTINCT FROM OLD."editionId"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt"
     OR NEW."requestKeyHash" IS DISTINCT FROM OLD."requestKeyHash" OR NEW."requestConfigHash" IS DISTINCT FROM OLD."requestConfigHash"
     OR NEW."isDemo" IS DISTINCT FROM OLD."isDemo" OR NEW."sourceChannel" IS DISTINCT FROM OLD."sourceChannel"
     OR (NEW."requestContactHmac" IS DISTINCT FROM OLD."requestContactHmac" AND NEW."requestContactHmac" IS NOT NULL) THEN
    RAISE EXCEPTION 'the identity of a booking never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."currentSnapshotVersion" <> OLD."currentSnapshotVersion" AND NEW."currentSnapshotVersion" <> OLD."currentSnapshotVersion" + 1 THEN
    RAISE EXCEPTION 'the snapshot version of a booking only goes up by one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT ((OLD."status", NEW."status") IN (
      ('requested'::"BookingStatus", 'approved'::"BookingStatus"), ('requested', 'declined'), ('requested', 'cancelled'), ('requested', 'expired'),
      ('approved', 'deposit_paid'), ('approved', 'cancelled'), ('approved', 'expired'),
      ('deposit_paid', 'confirmed'), ('deposit_paid', 'cancelled'), ('deposit_paid', 'completed'),
      ('confirmed', 'balance_paid'), ('confirmed', 'cancelled'), ('confirmed', 'completed'),
      ('deposit_paid', 'approved'), ('balance_paid', 'confirmed'), ('balance_paid', 'completed'), ('balance_paid', 'cancelled'),
      ('cancelled', 'refunded'), ('refunded', 'cancelled')
    )) THEN
      RAISE EXCEPTION 'booking status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'a change of booking status bumps its version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
