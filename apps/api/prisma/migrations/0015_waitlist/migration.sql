-- Task 2.6: the waiting list. Someone who does not live in a country we sell to joins the list for a package instead of
-- sending a booking request. No price, no stock and no money: offers and promotion arrive with task 6.5.

-- CreateEnum
CREATE TYPE "WaitlistReason" AS ENUM ('non_resident', 'sold_out');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('waiting', 'offered', 'converted', 'expired', 'withdrawn');

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "reason" "WaitlistReason" NOT NULL,
    "packageId" UUID NOT NULL,
    "countryOfResidence" CHAR(2) NOT NULL,
    "travellers" INTEGER NOT NULL,
    "position" SERIAL NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'waiting',
    "offeredAt" TIMESTAMPTZ(3),
    "offerExpiresAt" TIMESTAMPTZ(3),
    "withdrawnAt" TIMESTAMPTZ(3),
    "requestKeyHash" CHAR(64) NOT NULL,
    "requestConfigHash" CHAR(64) NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waitlist_entries_packageId_status_position_idx" ON "waitlist_entries"("packageId", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_customerId_requestKeyHash_key" ON "waitlist_entries"("customerId", "requestKeyHash");

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints and triggers that Prisma cannot express (it ignores them when it compares the schema with the migrations).

ALTER TABLE "waitlist_entries"
  ADD CONSTRAINT "waitlist_entries_country_check" CHECK ("countryOfResidence" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "waitlist_entries_travellers_check" CHECK ("travellers" >= 1),
  ADD CONSTRAINT "waitlist_entries_state_times_check" CHECK (
    ("status" <> 'offered' OR ("offeredAt" IS NOT NULL AND "offerExpiresAt" IS NOT NULL))
    AND ("status" <> 'withdrawn' OR "withdrawnAt" IS NOT NULL)
  );

-- One live entry (waiting or offered) per customer, package and reason: asking again does not queue twice.
CREATE UNIQUE INDEX "waitlist_entries_one_live_per_customer_package"
  ON "waitlist_entries"("customerId", "packageId", "reason") WHERE "status" IN ('waiting', 'offered');

-- Who the entry belongs to, what it is for and its place in the queue never change; the status only moves along the
-- allowed pairs (waiting to offered or withdrawn; offered to converted, expired or withdrawn). Only the privacy role
-- may delete (task 5.5); nobody truncates.
CREATE FUNCTION public.mt_waitlist_guard() RETURNS trigger
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
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'a waiting list entry''s owner, package, reason and place in the queue never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
       (OLD."status" = 'waiting' AND NEW."status" IN ('offered', 'withdrawn'))
    OR (OLD."status" = 'offered' AND NEW."status" IN ('converted', 'expired', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'a waiting list entry cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waitlist_entries_guard BEFORE UPDATE OR DELETE ON "waitlist_entries"
  FOR EACH ROW EXECUTE FUNCTION public.mt_waitlist_guard();
CREATE TRIGGER waitlist_entries_no_truncate BEFORE TRUNCATE ON "waitlist_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
