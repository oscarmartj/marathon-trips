-- Task 6.3: changes to a booking after its deposit, with the difference recalculated (plan
-- docs/plans/6.3-booking-amendments.md, section 3). A change adds a snapshot and an amendment row; rooms, extras and stock
-- claims become versioned so nothing is ever deleted or edited in place. Money is parked: no refund, fee or penalty here.

-- CreateEnum
CREATE TYPE "BookingAmendmentInitiator" AS ENUM ('customer', 'staff');

-- CreateEnum
CREATE TYPE "BookingAmendmentReason" AS ENUM ('customer_request', 'correction', 'supplier_change', 'other');

-- CreateEnum
CREATE TYPE "BookingAmendmentChange" AS ENUM ('room', 'nights', 'travellers_added', 'travellers_removed', 'participation', 'extras');

-- AlterTable
ALTER TABLE "booking_rooms" ADD COLUMN "addedInVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "removedInVersion" INTEGER;

-- AlterTable
ALTER TABLE "booking_extras" ADD COLUMN "addedInVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "removedInVersion" INTEGER;

-- AlterTable
ALTER TABLE "inventory_claims" ADD COLUMN "snapshotVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "booking_amendments" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "initiatedBy" "BookingAmendmentInitiator" NOT NULL,
    "actorUserId" UUID NOT NULL,
    "reasonCode" "BookingAmendmentReason" NOT NULL,
    "changes" "BookingAmendmentChange"[],
    "previousTotalMinor" BIGINT NOT NULL,
    "newTotalMinor" BIGINT NOT NULL,
    "priceDifferenceMinor" BIGINT NOT NULL,
    "collectedMinor" BIGINT NOT NULL,
    "outstandingMinor" BIGINT NOT NULL,
    "creditPendingMinor" BIGINT NOT NULL,
    "basisDriftMinor" BIGINT NOT NULL DEFAULT 0,
    "basisPriceVersionId" UUID NOT NULL,
    "basisAt" TIMESTAMPTZ(3) NOT NULL,
    "requestKeyHash" CHAR(64) NOT NULL,
    "requestBodyHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_amendments_pkey" PRIMARY KEY ("id")
);

-- DropIndex
DROP INDEX "inventory_claims_bookingId_poolId_key";

-- DropIndex
DROP INDEX "booking_extras_booking_extra_slot_key";

-- CreateIndex
CREATE UNIQUE INDEX "inventory_claims_bookingId_poolId_snapshotVersion_key" ON "inventory_claims"("bookingId", "poolId", "snapshotVersion");

-- CreateIndex
CREATE UNIQUE INDEX "booking_extras_booking_extra_slot_key" ON "booking_extras"("bookingId", "extraId", "travellerSlot", "addedInVersion") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "booking_amendments_basisPriceVersionId_idx" ON "booking_amendments"("basisPriceVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_amendments_bookingId_toVersion_key" ON "booking_amendments"("bookingId", "toVersion");

-- CreateIndex
CREATE UNIQUE INDEX "booking_amendments_bookingId_requestKeyHash_key" ON "booking_amendments"("bookingId", "requestKeyHash");

-- AddForeignKey
ALTER TABLE "booking_amendments" ADD CONSTRAINT "booking_amendments_bookingId_currency_fkey" FOREIGN KEY ("bookingId", "currency") REFERENCES "bookings"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_amendments" ADD CONSTRAINT "booking_amendments_basisPriceVersionId_currency_fkey" FOREIGN KEY ("basisPriceVersionId", "currency") REFERENCES "price_versions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints and triggers that Prisma cannot express (plan section 3). Prisma ignores them when it compares the schema
-- with the migrations.

-- ---- Stock claims: one held claim per booking and pool; the version a claim belongs to never changes ----
ALTER TABLE "inventory_claims"
  ADD CONSTRAINT "inventory_claims_snapshot_version_check" CHECK ("snapshotVersion" >= 1),
  ADD CONSTRAINT "inventory_claims_one_held_per_pool" EXCLUDE USING btree ("bookingId" WITH =, "poolId" WITH =) WHERE ("status" = 'held');

-- Replaces the 0022 version (which froze waitlistEntryId) and also freezes snapshotVersion (plan review m2).
CREATE OR REPLACE FUNCTION public.mt_inventory_claim_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an inventory claim is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."waitlistEntryId" IS DISTINCT FROM OLD."waitlistEntryId"
     OR NEW."poolId" IS DISTINCT FROM OLD."poolId" OR NEW."snapshotVersion" IS DISTINCT FROM OLD."snapshotVersion"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."status" <> 'held' OR NEW."status" <> 'released' THEN
    RAISE EXCEPTION 'an inventory claim is only released, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Rooms and extras: a change marks the rows it replaces removed, once; nothing else of a row changes ----
ALTER TABLE "booking_rooms"
  ADD CONSTRAINT "booking_rooms_versions_check" CHECK ("addedInVersion" >= 1 AND ("removedInVersion" IS NULL OR "removedInVersion" > "addedInVersion"));
ALTER TABLE "booking_extras"
  ADD CONSTRAINT "booking_extras_versions_check" CHECK ("addedInVersion" >= 1 AND ("removedInVersion" IS NULL OR "removedInVersion" > "addedInVersion"));

CREATE FUNCTION public.mt_booking_versioned_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD."removedInVersion" IS NOT NULL OR NEW."removedInVersion" IS NULL
     OR (to_jsonb(NEW) - 'removedInVersion') IS DISTINCT FROM (to_jsonb(OLD) - 'removedInVersion') THEN
    RAISE EXCEPTION 'a % row never changes; a change of the booking marks it removed, once', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_rooms_guard BEFORE UPDATE ON "booking_rooms"
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_versioned_part_guard();
CREATE TRIGGER booking_extras_guard BEFORE UPDATE ON "booking_extras"
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_versioned_part_guard();

-- ---- Places: removed once; one current lead, which only a change can move to another place ----
CREATE OR REPLACE FUNCTION public.mt_booking_traveller_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."slot" IS DISTINCT FROM OLD."slot" OR NEW."participationType" IS DISTINCT FROM OLD."participationType"
     OR NEW."raceDistanceId" IS DISTINCT FROM OLD."raceDistanceId" OR NEW."isLead" IS DISTINCT FROM OLD."isLead"
     OR NEW."addedInVersion" IS DISTINCT FROM OLD."addedInVersion"
     OR (OLD."removedInVersion" IS NOT NULL AND NEW."removedInVersion" IS DISTINCT FROM OLD."removedInVersion") THEN
    RAISE EXCEPTION 'a place of a booking never changes; amendments mark it removed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "booking_travellers" DROP CONSTRAINT "booking_travellers_slot_check";
ALTER TABLE "booking_travellers"
  ADD CONSTRAINT "booking_travellers_slot_check" CHECK ("slot" >= 1 AND ("slot" <> 1 OR "isLead") AND (NOT "isLead" OR "slot" = 1 OR "addedInVersion" > 1)),
  ADD CONSTRAINT "booking_travellers_one_current_lead" EXCLUDE USING btree ("bookingId" WITH =) WHERE ("isLead" AND "removedInVersion" IS NULL);

-- Exactly one current lead per booking, at commit (plan review m1): the EXCLUDE above only says "at most one".
CREATE FUNCTION public.mt_booking_has_one_lead() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (SELECT count(*) FROM public.booking_travellers WHERE "bookingId" = NEW."bookingId" AND "isLead" AND "removedInVersion" IS NULL) <> 1 THEN
    RAISE EXCEPTION 'a booking has exactly one current lead place' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER booking_travellers_one_lead AFTER INSERT OR UPDATE ON "booking_travellers"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_has_one_lead();

-- ---- Amendments: append-only; amounts consistent; written with their snapshot, in an amendable state ----
ALTER TABLE "booking_amendments"
  ADD CONSTRAINT "booking_amendments_versions_check" CHECK ("fromVersion" >= 1 AND "toVersion" = "fromVersion" + 1),
  ADD CONSTRAINT "booking_amendments_changes_check" CHECK (cardinality("changes") >= 1),
  ADD CONSTRAINT "booking_amendments_amounts_check" CHECK (
    "previousTotalMinor" >= 0 AND "newTotalMinor" >= 0 AND "collectedMinor" >= 0 AND "outstandingMinor" >= 0 AND "creditPendingMinor" >= 0
    AND "newTotalMinor" = "previousTotalMinor" + "priceDifferenceMinor"
    AND "outstandingMinor" - "creditPendingMinor" = "newTotalMinor" - "collectedMinor"
    AND ("outstandingMinor" = 0 OR "creditPendingMinor" = 0)),
  ADD CONSTRAINT "booking_amendments_drift_check" CHECK ("basisDriftMinor" <= 0 AND ("basisDriftMinor" = 0 OR ("reasonCode" = 'correction' AND "initiatedBy" = 'staff'))),
  ADD CONSTRAINT "booking_amendments_customer_check" CHECK ("initiatedBy" = 'staff' OR ("reasonCode" = 'customer_request' AND "priceDifferenceMinor" >= 0)),
  ADD CONSTRAINT "booking_amendments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
CREATE TRIGGER booking_amendments_append_only BEFORE UPDATE OR DELETE ON "booking_amendments"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER booking_amendments_no_truncate BEFORE TRUNCATE ON "booking_amendments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- An amendment row is written after its snapshot and the booking's move to it, while the booking is in a state that
-- may be changed (deposit_paid, confirmed, balance_paid; plan review m7), and its totals are those of the two snapshots.
CREATE FUNCTION public.mt_booking_amendment_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
BEGIN
  SELECT "status", "currentSnapshotVersion" INTO b FROM public.bookings WHERE "id" = NEW."bookingId";
  IF NOT FOUND OR b."status" NOT IN ('deposit_paid', 'confirmed', 'balance_paid') OR b."currentSnapshotVersion" <> NEW."toVersion" THEN
    RAISE EXCEPTION 'a booking is only changed after its deposit, to its current snapshot' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.booking_snapshots s WHERE s."bookingId" = NEW."bookingId" AND s."version" = NEW."fromVersion" AND s."totalMinor" = NEW."previousTotalMinor")
     OR NOT EXISTS (SELECT 1 FROM public.booking_snapshots s WHERE s."bookingId" = NEW."bookingId" AND s."version" = NEW."toVersion" AND s."kind" = 'amendment' AND s."totalMinor" = NEW."newTotalMinor") THEN
    RAISE EXCEPTION 'an amendment''s totals are those of its two snapshots' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_amendments_insert BEFORE INSERT ON "booking_amendments"
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_amendment_insert();

-- A snapshot of kind amendment has its amendment row at commit: no snapshot version moves without a recorded change.
CREATE FUNCTION public.mt_amendment_snapshot_has_row() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."kind" = 'amendment' AND NOT EXISTS (SELECT 1 FROM public.booking_amendments a WHERE a."bookingId" = NEW."bookingId" AND a."toVersion" = NEW."version") THEN
    RAISE EXCEPTION 'an amendment snapshot needs its amendment record' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER booking_snapshots_amendment_row AFTER INSERT ON "booking_snapshots"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_amendment_snapshot_has_row();
