-- Task 6.4: tiered cancellation policies, the penalty and the refund (plan docs/plans/6.4-cancellation-policies.md,
-- sections 5 and 13). Policies are frozen once active and a booking keeps the one it was sold under; a cancellation is
-- one immutable row per booking; the plan of a cancelled booking owes its penalty; refunds for a cancellation are capped.

-- AlterEnum (not used in this migration: a new enum value cannot be used in the transaction that adds it)
ALTER TYPE "PaymentScheduleItemKind" ADD VALUE 'penalty';

-- CreateEnum
CREATE TYPE "CancellationPolicyStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "CancellationPenaltyMode" AS ENUM ('percent', 'fixed_per_person', 'fixed_per_booking');

-- CreateEnum
CREATE TYPE "CancellationRequestedBy" AS ENUM ('customer', 'staff');

-- CreateEnum
CREATE TYPE "CancellationBasis" AS ENUM ('policy', 'not_contracted', 'no_policy', 'operator_cancelled');

-- AlterTable
ALTER TABLE "booking_snapshots" ADD COLUMN "cancellationPolicyId" UUID;

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN "cancellationId" UUID;

-- AlterTable
ALTER TABLE "terms_acceptances" ADD COLUMN "cancellationPolicyDigest" CHAR(64);

-- CreateTable
CREATE TABLE "cancellation_policies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" JSONB NOT NULL,
    "status" "CancellationPolicyStatus" NOT NULL DEFAULT 'draft',
    "currency" CHAR(3),
    "activatedAt" TIMESTAMPTZ(3),
    "activatedById" UUID,
    "archivedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_tiers" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "minDaysBeforeDeparture" INTEGER NOT NULL,
    "penaltyMode" "CancellationPenaltyMode" NOT NULL,
    "penaltyBps" INTEGER,
    "penaltyMinor" BIGINT,
    "currency" CHAR(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_cancellation_policies" (
    "packageId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "policyId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "package_cancellation_policies_pkey" PRIMARY KEY ("packageId")
);

-- CreateTable
CREATE TABLE "cancellations" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "requestedBy" "CancellationRequestedBy" NOT NULL,
    "requestedById" UUID NOT NULL,
    "bookingStatus" "BookingStatus" NOT NULL,
    "snapshotVersion" INTEGER NOT NULL,
    "basis" "CancellationBasis" NOT NULL,
    "cancellationPolicyId" UUID,
    "cancellationRequestId" UUID,
    "businessDate" DATE NOT NULL,
    "processedDate" DATE NOT NULL,
    "daysBeforeDeparture" INTEGER NOT NULL,
    "tierMinDays" INTEGER,
    "policySnapshot" JSONB NOT NULL,
    "baseTotalMinor" BIGINT NOT NULL,
    "places" INTEGER NOT NULL,
    "collectedMinor" BIGINT NOT NULL,
    "policyPenaltyMinor" BIGINT NOT NULL,
    "penaltyMinor" BIGINT NOT NULL,
    "waivedMinor" BIGINT NOT NULL,
    "refundableMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_requests" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "requestedBy" "CancellationRequestedBy" NOT NULL,
    "requestedById" UUID NOT NULL,
    "businessDate" DATE NOT NULL,
    "blockedReason" TEXT NOT NULL,
    "quoteDigest" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cancellation_policies_status_idx" ON "cancellation_policies"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_tiers_policyId_minDaysBeforeDeparture_key" ON "cancellation_tiers"("policyId", "minDaysBeforeDeparture");

-- CreateIndex
CREATE INDEX "package_cancellation_policies_policyId_idx" ON "package_cancellation_policies"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "cancellations_bookingId_key" ON "cancellations"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "cancellations_cancellationRequestId_key" ON "cancellations"("cancellationRequestId");

-- CreateIndex
CREATE INDEX "cancellations_cancellationPolicyId_idx" ON "cancellations"("cancellationPolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "cancellations_id_bookingId_key" ON "cancellations"("id", "bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_requests_bookingId_businessDate_key" ON "cancellation_requests"("bookingId", "businessDate");

-- CreateIndex
CREATE INDEX "cancellation_requests_bookingId_idx" ON "cancellation_requests"("bookingId");

-- CreateIndex
CREATE INDEX "refunds_cancellationId_idx" ON "refunds"("cancellationId");

-- AddForeignKey
ALTER TABLE "booking_snapshots" ADD CONSTRAINT "booking_snapshots_cancellationPolicyId_fkey" FOREIGN KEY ("cancellationPolicyId") REFERENCES "cancellation_policies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_cancellation_fkey" FOREIGN KEY ("cancellationId", "bookingId") REFERENCES "cancellations"("id", "bookingId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cancellation_tiers" ADD CONSTRAINT "cancellation_tiers_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "cancellation_policies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_cancellation_policies" ADD CONSTRAINT "package_cancellation_policies_packageId_currency_fkey" FOREIGN KEY ("packageId", "currency") REFERENCES "packages"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_cancellation_policies" ADD CONSTRAINT "package_cancellation_policies_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "cancellation_policies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_bookingId_currency_fkey" FOREIGN KEY ("bookingId", "currency") REFERENCES "bookings"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_cancellationPolicyId_fkey" FOREIGN KEY ("cancellationPolicyId") REFERENCES "cancellation_policies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cancellations" ADD CONSTRAINT "cancellations_cancellationRequestId_fkey" FOREIGN KEY ("cancellationRequestId") REFERENCES "cancellation_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints and triggers that Prisma cannot express (plan sections 5 and 13). Prisma ignores them when it compares
-- the schema with the migrations.

-- ---- Policies and tiers: a draft is edited, an active policy is frozen, archived only when no package uses it ----
ALTER TABLE "cancellation_policies"
  ADD CONSTRAINT "cancellation_policies_name_check" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "cancellation_policies_currency_check" CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "cancellation_policies_status_check" CHECK (
    ("status" = 'draft' AND "activatedAt" IS NULL AND "archivedAt" IS NULL)
    OR ("status" = 'active' AND "activatedAt" IS NOT NULL AND "archivedAt" IS NULL)
    OR ("status" = 'archived' AND "activatedAt" IS NOT NULL AND "archivedAt" IS NOT NULL));

ALTER TABLE "cancellation_tiers"
  ADD CONSTRAINT "cancellation_tiers_days_check" CHECK ("minDaysBeforeDeparture" BETWEEN 0 AND 3650),
  ADD CONSTRAINT "cancellation_tiers_mode_check" CHECK (
    ("penaltyMode" = 'percent' AND "penaltyBps" BETWEEN 0 AND 10000 AND "penaltyMinor" IS NULL AND "currency" IS NULL)
    OR ("penaltyMode" IN ('fixed_per_person', 'fixed_per_booking') AND "penaltyBps" IS NULL AND "penaltyMinor" BETWEEN 0 AND 99999999999 AND "currency" ~ '^[A-Z]{3}$'));

CREATE FUNCTION public.mt_cancellation_policy_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  tiers integer;
  zero boolean;
  bad_currency boolean;
  has_fixed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'a cancellation policy that was activated is never deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'the identity of a cancellation policy never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'draft' THEN
    IF NEW."status" = 'archived' THEN
      RAISE EXCEPTION 'a draft cancellation policy is deleted, not archived' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'active' THEN
      -- The same rules as the service (plan section 4): a tier at 0 days, at most 10, one currency for the fixed tiers.
      SELECT count(*), bool_or(t."minDaysBeforeDeparture" = 0), bool_or(t."currency" IS DISTINCT FROM NEW."currency" AND t."currency" IS NOT NULL),
             bool_or(t."penaltyMode" <> 'percent')
        INTO tiers, zero, bad_currency, has_fixed
        FROM public.cancellation_tiers t WHERE t."policyId" = NEW."id";
      IF tiers < 1 OR tiers > 10 OR NOT coalesce(zero, false) OR coalesce(bad_currency, false) OR (coalesce(has_fixed, false) <> (NEW."currency" IS NOT NULL)) THEN
        RAISE EXCEPTION 'a cancellation policy needs 1 to 10 tiers, one at 0 days, and one currency for its fixed tiers' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- Active or archived: frozen. Only active → archived, and only while no package sells under it.
  IF NEW."name" IS DISTINCT FROM OLD."name" OR NEW."description" IS DISTINCT FROM OLD."description" OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" OR NEW."activatedById" IS DISTINCT FROM OLD."activatedById"
     OR (OLD."status" = 'archived' AND (NEW."status" IS DISTINCT FROM OLD."status" OR NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt"))
     OR (OLD."status" = 'active' AND NEW."status" NOT IN ('active', 'archived')) THEN
    RAISE EXCEPTION 'an active cancellation policy never changes: duplicate it into a new draft' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'active' AND NEW."status" = 'archived'
     AND EXISTS (SELECT 1 FROM public.package_cancellation_policies a WHERE a."policyId" = NEW."id") THEN
    RAISE EXCEPTION 'a cancellation policy in use by a package cannot be archived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cancellation_policies_guard BEFORE UPDATE OR DELETE ON "cancellation_policies"
  FOR EACH ROW EXECUTE FUNCTION public.mt_cancellation_policy_guard();
CREATE TRIGGER cancellation_policies_no_truncate BEFORE TRUNCATE ON "cancellation_policies"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- A tier changes only while its policy is a draft; the policy row is read FOR SHARE so activation waits for it.
CREATE FUNCTION public.mt_cancellation_tier_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  st text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."policyId" IS DISTINCT FROM OLD."policyId" THEN
    RAISE EXCEPTION 'a tier never moves to another policy' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p."status"::text INTO st FROM public.cancellation_policies p
   WHERE p."id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."policyId" ELSE NEW."policyId" END FOR SHARE;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'the tiers of an active cancellation policy never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cancellation_tiers_guard BEFORE INSERT OR UPDATE OR DELETE ON "cancellation_tiers"
  FOR EACH ROW EXECUTE FUNCTION public.mt_cancellation_tier_guard();
CREATE TRIGGER cancellation_tiers_no_truncate BEFORE TRUNCATE ON "cancellation_tiers"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- A package sells under an active policy in its currency (review m5: FOR SHARE, so an archive waits or is refused).
CREATE FUNCTION public.mt_package_cancellation_policy_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  p record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."packageId" IS DISTINCT FROM OLD."packageId" THEN
    RAISE EXCEPTION 'an assignment never moves to another package' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT "status"::text AS status, "currency" INTO p FROM public.cancellation_policies WHERE "id" = NEW."policyId" FOR SHARE;
  IF NOT FOUND OR p.status <> 'active' THEN
    RAISE EXCEPTION 'a package sells only under an active cancellation policy' USING ERRCODE = 'check_violation';
  END IF;
  IF p."currency" IS NOT NULL AND p."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'the fixed tiers of the policy are in another currency than the package' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER package_cancellation_policies_guard BEFORE INSERT OR UPDATE ON "package_cancellation_policies"
  FOR EACH ROW EXECUTE FUNCTION public.mt_package_cancellation_policy_guard();
CREATE TRIGGER package_cancellation_policies_no_truncate BEFORE TRUNCATE ON "package_cancellation_policies"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Snapshots keep the policy the booking was sold under (decision 2): set by the request, copied by amendments ----
CREATE FUNCTION public.mt_booking_snapshot_policy() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  st text;
  prev uuid;
BEGIN
  IF NEW."version" = 1 THEN
    IF NEW."cancellationPolicyId" IS NOT NULL THEN
      SELECT p."status"::text INTO st FROM public.cancellation_policies p WHERE p."id" = NEW."cancellationPolicyId" FOR SHARE;
      IF st IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'a booking is sold only under an active cancellation policy' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT s."cancellationPolicyId" INTO prev FROM public.booking_snapshots s WHERE s."bookingId" = NEW."bookingId" AND s."version" = NEW."version" - 1;
  IF NEW."cancellationPolicyId" IS DISTINCT FROM prev THEN
    RAISE EXCEPTION 'a change of a booking keeps the cancellation policy it was sold under' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_snapshots_cancellation_policy BEFORE INSERT ON "booking_snapshots"
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_snapshot_policy();

-- ---- Cancellations: one immutable row per booking, its amounts tied together (sections 2 and 13) ----
ALTER TABLE "cancellations"
  ADD CONSTRAINT "cancellations_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "cancellations_amounts_check" CHECK (
    "baseTotalMinor" >= 0 AND "policyPenaltyMinor" >= 0 AND "penaltyMinor" >= 0 AND "waivedMinor" >= 0 AND "refundableMinor" >= 0
    AND "policyPenaltyMinor" <= "baseTotalMinor"
    AND "penaltyMinor" = LEAST("policyPenaltyMinor", GREATEST("collectedMinor", 0))
    AND "waivedMinor" = "policyPenaltyMinor" - "penaltyMinor"
    AND "refundableMinor" = GREATEST("collectedMinor", 0) - "penaltyMinor"),
  ADD CONSTRAINT "cancellations_places_check" CHECK ("places" BETWEEN 0 AND 80 AND "snapshotVersion" >= 1),
  ADD CONSTRAINT "cancellations_dates_check" CHECK ("businessDate" <= "processedDate"),
  ADD CONSTRAINT "cancellations_basis_check" CHECK (
    ("basis" = 'policy') = ("cancellationPolicyId" IS NOT NULL AND "tierMinDays" IS NOT NULL)
    AND ("basis" = 'policy' OR "policyPenaltyMinor" = 0)
    AND ("basis" <> 'not_contracted' OR "bookingStatus" IN ('requested', 'approved'))
    AND ("basis" NOT IN ('policy', 'no_policy') OR "bookingStatus" IN ('deposit_paid', 'confirmed', 'balance_paid'))
    AND ("basis" <> 'operator_cancelled' OR "requestedBy" = 'staff')
    AND ("requestedBy" = 'staff' OR ("basis" = 'policy' AND "daysBeforeDeparture" >= 0)));
CREATE TRIGGER cancellations_immutable BEFORE UPDATE OR DELETE ON "cancellations"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER cancellations_no_truncate BEFORE TRUNCATE ON "cancellations"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Written while the booking is still in a state that can be cancelled, against its current snapshot and its policy.
CREATE FUNCTION public.mt_cancellation_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
  snap_policy uuid;
BEGIN
  SELECT "status"::text AS status, "currentSnapshotVersion" AS v INTO b FROM public.bookings WHERE "id" = NEW."bookingId";
  IF NOT FOUND OR b.status NOT IN ('requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid') OR b.status <> NEW."bookingStatus"::text OR b.v <> NEW."snapshotVersion" THEN
    RAISE EXCEPTION 'a cancellation is written for a booking that can be cancelled, in its current state and snapshot' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."cancellationPolicyId" INTO snap_policy FROM public.booking_snapshots s WHERE s."bookingId" = NEW."bookingId" AND s."version" = NEW."snapshotVersion";
  IF NEW."basis" = 'policy' AND NEW."cancellationPolicyId" IS DISTINCT FROM snap_policy THEN
    RAISE EXCEPTION 'a cancellation applies the policy the booking was sold under' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."basis" = 'no_policy' AND snap_policy IS NOT NULL THEN
    RAISE EXCEPTION 'a booking sold under a policy is cancelled with it' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."cancellationRequestId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.cancellation_requests r WHERE r."id" = NEW."cancellationRequestId" AND r."bookingId" = NEW."bookingId" AND r."businessDate" = NEW."businessDate") THEN
    RAISE EXCEPTION 'a cancellation keeps the date of its own booking''s request' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cancellations_insert BEFORE INSERT ON "cancellations"
  FOR EACH ROW EXECUTE FUNCTION public.mt_cancellation_insert();

-- Review m4: at commit, a booking that moved into cancelled has its cancellation, and a cancellation's booking is
-- cancelled or refunded. Bookings cancelled before this migration are never checked (only transitions after it).
CREATE FUNCTION public.mt_cancellation_matches_booking() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  st text;
BEGIN
  IF TG_TABLE_NAME = 'bookings' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cancellations c WHERE c."bookingId" = NEW."id") THEN
      RAISE EXCEPTION 'a booking is cancelled with its cancellation record' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;
  SELECT b."status"::text INTO st FROM public.bookings b WHERE b."id" = NEW."bookingId";
  IF st IS NULL OR st NOT IN ('cancelled', 'refunded') THEN
    RAISE EXCEPTION 'a cancellation record belongs to a cancelled booking' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_cancelled_has_cancellation AFTER UPDATE OF "status" ON "bookings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."status" = 'cancelled' AND OLD."status" NOT IN ('cancelled', 'refunded'))
  EXECUTE FUNCTION public.mt_cancellation_matches_booking();
CREATE CONSTRAINT TRIGGER cancellations_booking_cancelled AFTER INSERT ON "cancellations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_cancellation_matches_booking();

-- ---- Blocked attempts (section 13, M4): immutable; the first of each window, one per booking and date ----
ALTER TABLE "cancellation_requests"
  ADD CONSTRAINT "cancellation_requests_reason_check" CHECK ("blockedReason" ~ '^[a-z][a-z_]{0,59}$'),
  ADD CONSTRAINT "cancellation_requests_digest_check" CHECK ("quoteDigest" ~ '^[0-9a-f]{64}$');
-- Like disputes (0035): the API's role never deletes or truncates these records (the triggers refuse it too).
REVOKE DELETE, TRUNCATE ON "cancellations" FROM mt_app;
REVOKE DELETE, TRUNCATE ON "cancellation_requests" FROM mt_app;
CREATE TRIGGER cancellation_requests_immutable BEFORE UPDATE OR DELETE ON "cancellation_requests"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER cancellation_requests_no_truncate BEFORE TRUNCATE ON "cancellation_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Refunds for a cancellation (P9, P10; review m1: an external refund, purpose null, carries no cancellation) ----
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_purpose_scope_check";
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_purpose_scope_check" CHECK ("purpose" IS NULL OR "purpose" IN ('overpayment_return', 'cancellation')),
  ADD CONSTRAINT "refunds_cancellation_check" CHECK (("purpose" IS NOT DISTINCT FROM 'cancellation') = ("cancellationId" IS NOT NULL));

ALTER TABLE "terms_acceptances"
  ADD CONSTRAINT "terms_acceptances_policy_digest_check" CHECK ("cancellationPolicyDigest" IS NULL OR "cancellationPolicyDigest" ~ '^[0-9a-f]{64}$');

-- ---- The plan of a cancelled booking owes its penalty (P8); 0 without a cancellation (cancelled before 0038) ----
CREATE OR REPLACE FUNCTION public.mt_payment_plan_matches_booking() RETURNS trigger
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
  owed := CASE
    WHEN b."status" IN ('approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed') THEN b."totalMinor"
    WHEN b."status" IN ('cancelled', 'refunded') THEN COALESCE((SELECT c."penaltyMinor" FROM public.cancellations c WHERE c."bookingId" = bid), 0)
    ELSE 0 END;
  SELECT COALESCE(sum(i."amountMinor"), 0) INTO active_sum FROM public.payment_schedule_items i WHERE i."bookingId" = bid AND i."state" = 'active';
  IF active_sum <> owed THEN
    RAISE EXCEPTION 'the active items of a payment plan must add up to what the booking owes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

-- ---- Erasure (review M1): a cancelled booking with a cancellation blocks it only while something is left to refund ----
GRANT SELECT ("bookingId", "penaltyMinor") ON "cancellations" TO mt_privacy;
CREATE OR REPLACE FUNCTION public.privacy_active_trip_reason(p_customer uuid) RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH held AS (
    SELECT b.id, b."customerId", b.status, b."totalMinor",
      (SELECT COALESCE(sum(p."amountMinor"), 0) FROM public.payments p WHERE p."bookingId" = b.id AND p.status = 'succeeded')
      - (SELECT COALESCE(sum(r."amountMinor"), 0) FROM public.refunds r WHERE r."bookingId" = b.id AND r.status = 'succeeded')
      - (SELECT COALESCE(sum(d."amountMinor"), 0) FROM public.disputes d WHERE d."bookingId" = b.id AND d."fundsWithdrawnAt" IS NOT NULL AND d."fundsReinstatedAt" IS NULL) AS net,
      (SELECT c."penaltyMinor" FROM public.cancellations c WHERE c."bookingId" = b.id) AS penalty
    FROM public.bookings b
    WHERE b."customerId" = p_customer OR EXISTS (SELECT 1 FROM public.payments q WHERE q."bookingId" = b.id AND q."payerCustomerId" = p_customer)
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.bookings b WHERE b."customerId" = p_customer
                   AND b.status IN ('requested', 'approved', 'deposit_paid', 'confirmed')) THEN 'open_booking'
    WHEN EXISTS (SELECT 1 FROM public.bookings b WHERE b."customerId" = p_customer AND b.status = 'balance_paid'
                   AND b."returnDate" >= (pg_catalog.now() AT TIME ZONE 'Australia/Brisbane')::date) THEN 'trip_not_finished'
    WHEN EXISTS (SELECT 1 FROM public.payments p
                  WHERE (p."payerCustomerId" = p_customer OR p."bookingId" IN (SELECT b.id FROM public.bookings b WHERE b."customerId" = p_customer))
                    AND p.status IN ('created', 'pending', 'requires_action'))
      OR EXISTS (SELECT 1 FROM public.refunds r JOIN public.payments p ON p.id = r."paymentId"
                  WHERE (p."payerCustomerId" = p_customer OR r."bookingId" IN (SELECT b.id FROM public.bookings b WHERE b."customerId" = p_customer))
                    AND r.status IN ('requested', 'pending')) THEN 'live_payment'
    WHEN EXISTS (SELECT 1 FROM public.disputes d JOIN public.payments p ON p.id = d."paymentId"
                  WHERE (p."payerCustomerId" = p_customer OR d."bookingId" IN (SELECT b.id FROM public.bookings b WHERE b."customerId" = p_customer))
                    AND d.status IN ('open', 'evidence_submitted')) THEN 'open_dispute'
    -- Cancelled with a cancellation (task 6.4): only while more is held than the penalty it keeps.
    WHEN EXISTS (SELECT 1 FROM held h WHERE h.status = 'cancelled' AND h.penalty IS NOT NULL AND h.net > h.penalty) THEN 'refund_may_be_due'
    -- Cancelled before 0038 (no cancellation), declined or expired: any succeeded payment, as before.
    WHEN EXISTS (SELECT 1 FROM public.bookings b JOIN public.payments p ON p."bookingId" = b.id
                  WHERE (b."customerId" = p_customer OR p."payerCustomerId" = p_customer)
                    AND (b.status IN ('declined', 'expired') OR (b.status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM public.cancellations c WHERE c."bookingId" = b.id)))
                    AND p.status = 'succeeded') THEN 'refund_may_be_due'
    WHEN EXISTS (SELECT 1 FROM held h WHERE h.net > h."totalMinor") THEN 'refund_may_be_due'
  END
$$;
