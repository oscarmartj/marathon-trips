-- Task 5.1: payment links (plan docs/plans/5.1-customer-area.md, section 5). A link is a single-use capability that
-- staff send to the booking's own address: it pays one plan item of one booking, holds no amount and no personal data,
-- and keeps only the SHA-256 of its token. A payment started through a link names it, so the link can be marked used in
-- the same transaction as the money and the return address can follow the path the attempt was started on.

-- AlterEnum
ALTER TYPE "AuditActorType" ADD VALUE 'payment_link';

-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('active', 'used', 'revoked');

-- CreateTable
CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "targetScheduleItemId" UUID NOT NULL,
    "tokenHash" CHAR(64),
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "paymentLinkId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_tokenHash_key" ON "payment_links"("tokenHash");
CREATE INDEX "payment_links_bookingId_status_idx" ON "payment_links"("bookingId", "status");
CREATE UNIQUE INDEX "payment_links_id_bookingId_key" ON "payment_links"("id", "bookingId");
CREATE INDEX "payments_paymentLinkId_idx" ON "payments"("paymentLinkId");

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_targetScheduleItemId_bookingId_fkey" FOREIGN KEY ("targetScheduleItemId", "bookingId") REFERENCES "payment_schedule_items"("id", "bookingId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "payments" ADD CONSTRAINT "payments_paymentLinkId_bookingId_fkey" FOREIGN KEY ("paymentLinkId", "bookingId") REFERENCES "payment_links"("id", "bookingId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints that Prisma cannot express.
-- One active link per booking; the timestamps match the status; a hash is hex.
CREATE UNIQUE INDEX "payment_links_one_active_per_booking" ON "payment_links"("bookingId") WHERE "status" = 'active';
ALTER TABLE "payment_links"
  ADD CONSTRAINT "payment_links_token_hash_check" CHECK ("tokenHash" IS NULL OR "tokenHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "payment_links_status_times_check" CHECK (
    ("status" = 'used') = ("usedAt" IS NOT NULL) AND ("status" = 'revoked') = ("revokedAt" IS NOT NULL)),
  ADD CONSTRAINT "payment_links_expiry_check" CHECK ("expiresAt" > "createdAt");

-- A link is never deleted; only active -> used or revoked; the token hash is set once while active, or cleared when the
-- link is revoked or already used (erasure); everything else is fixed at creation (review m5).
CREATE FUNCTION public.mt_payment_link_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment link is never deleted; revoke it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'active' OR NEW."tokenHash" IS NOT NULL THEN
      RAISE EXCEPTION 'a payment link starts active and without a token' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."targetScheduleItemId" IS DISTINCT FROM OLD."targetScheduleItemId" OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt")
     OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'the identity of a payment link never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'active' AND NEW."status" IN ('used', 'revoked')) THEN
    RAISE EXCEPTION 'a payment link only goes from active to used or revoked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash" AND NOT (
       (OLD."tokenHash" IS NULL AND NEW."tokenHash" IS NOT NULL AND OLD."status" = 'active' AND NEW."status" = 'active')
    OR (NEW."tokenHash" IS NULL AND NEW."status" IN ('revoked', 'used') AND (OLD."status" = NEW."status" OR NEW."status" = 'revoked'))) THEN
    RAISE EXCEPTION 'a payment link token is set once while active, or cleared once it is revoked or used' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_links_guard BEFORE INSERT OR UPDATE OR DELETE ON "payment_links"
  FOR EACH ROW EXECUTE FUNCTION public.mt_payment_link_guard();
CREATE TRIGGER payment_links_no_truncate BEFORE TRUNCATE ON "payment_links"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
REVOKE DELETE ON "payment_links" FROM mt_app;

-- The link a payment was started through never changes either (added to the payment guard of migration 0017).
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
     OR NEW."paymentLinkId" IS DISTINCT FROM OLD."paymentLinkId"
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
