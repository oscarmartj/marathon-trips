-- Task 6.5: offers and automatic promotion on the waiting list. An entry for a sold out package keeps the request to
-- price when a place comes up; an offer holds the released places in an inventory claim owned by the entry; accepting
-- turns the entry into a booking request.

-- AlterTable
ALTER TABLE "waitlist_entries" ADD COLUMN "convertedAt" TIMESTAMPTZ(3),
ADD COLUMN "expiredAt" TIMESTAMPTZ(3),
ADD COLUMN "configuration" JSONB,
ADD COLUMN "bookingId" UUID;

-- AlterTable
ALTER TABLE "inventory_claims" ALTER COLUMN "bookingId" DROP NOT NULL,
ADD COLUMN "waitlistEntryId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "inventory_claims_waitlistEntryId_poolId_key" ON "inventory_claims"("waitlistEntryId", "poolId");

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_claims" ADD CONSTRAINT "inventory_claims_waitlistEntryId_fkey" FOREIGN KEY ("waitlistEntryId") REFERENCES "waitlist_entries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints and triggers that Prisma cannot express.

ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_entries_sold_out_configuration_check" CHECK ("reason" <> 'sold_out' OR "configuration" IS NOT NULL),
  ADD CONSTRAINT "waitlist_entries_converted_booking_check" CHECK (("status" = 'converted') = ("bookingId" IS NOT NULL)),
  ADD CONSTRAINT "waitlist_entries_close_times_check" CHECK (
    ("status" <> 'converted' OR "convertedAt" IS NOT NULL) AND ("status" <> 'expired' OR "expiredAt" IS NOT NULL)
  );

-- Same rules as 0016, and now the request an entry keeps never changes, and the booking is set once.
CREATE OR REPLACE FUNCTION public.mt_waitlist_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = 'mt_privacy' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a waiting list entry is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."packageId" IS DISTINCT FROM OLD."packageId" OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."position" IS DISTINCT FROM OLD."position" OR NEW."isDemo" IS DISTINCT FROM OLD."isDemo"
     OR NEW."requestKeyHash" IS DISTINCT FROM OLD."requestKeyHash" OR NEW."requestConfigHash" IS DISTINCT FROM OLD."requestConfigHash"
     OR NEW."configuration" IS DISTINCT FROM OLD."configuration"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (NEW."requestContactHmac" IS DISTINCT FROM OLD."requestContactHmac" AND NEW."requestContactHmac" IS NOT NULL) THEN
    RAISE EXCEPTION 'a waiting list entry''s owner, package, reason, request and place in the queue never change (the contact HMAC may only be cleared)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."bookingId" IS NOT NULL AND NEW."bookingId" IS DISTINCT FROM OLD."bookingId" THEN
    RAISE EXCEPTION 'the booking of a converted waiting list entry never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'waiting' AND NEW."status" IN ('offered', 'withdrawn'))
    OR (OLD."status" = 'offered' AND NEW."status" IN ('converted', 'expired', 'withdrawn'))
    OR (OLD."status" = 'waiting' AND NEW."status" = 'expired' AND OLD."reason" = 'sold_out')
  ) THEN
    RAISE EXCEPTION 'a waiting list entry cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- A claim belongs to exactly one owner: a booking or a waiting list entry whose offer holds the places.
ALTER TABLE "inventory_claims"
  ADD CONSTRAINT "inventory_claims_one_owner_check" CHECK (("bookingId" IS NULL) <> ("waitlistEntryId" IS NULL));
CREATE OR REPLACE FUNCTION public.mt_inventory_claim_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an inventory claim is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."waitlistEntryId" IS DISTINCT FROM OLD."waitlistEntryId"
     OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."status" <> 'held' OR NEW."status" <> 'released' THEN
    RAISE EXCEPTION 'an inventory claim is only released, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
