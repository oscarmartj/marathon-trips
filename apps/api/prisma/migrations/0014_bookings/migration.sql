-- Task 2.4: customers, booking requests with an immutable snapshot, the booking state machine's safety net and the
-- stock each booking holds. Plan docs/plans/2.4-booking-requests.md. No money moves here.

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('requested', 'approved', 'deposit_paid', 'confirmed', 'balance_paid', 'completed', 'declined', 'expired', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "BookingKind" AS ENUM ('catalogue', 'bespoke');

-- CreateEnum
CREATE TYPE "BookingSourceChannel" AS ENUM ('web', 'panel', 'api');

-- CreateEnum
CREATE TYPE "CustomerSource" AS ENUM ('web', 'panel');

-- CreateEnum
CREATE TYPE "BookingSnapshotKind" AS ENUM ('original', 'amendment');

-- CreateEnum
CREATE TYPE "InventoryClaimStatus" AS ENUM ('held', 'released');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "userKind" "UserKind" NOT NULL DEFAULT 'customer',
    "email" CITEXT NOT NULL,
    "givenName" TEXT NOT NULL,
    "familyName" TEXT NOT NULL,
    "phone" TEXT,
    "countryOfResidence" CHAR(2) NOT NULL,
    "preferredLocale" TEXT NOT NULL DEFAULT 'en-AU',
    "source" "CustomerSource" NOT NULL,
    "anonymisedAt" TIMESTAMPTZ(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "kind" "BookingKind" NOT NULL,
    "packageId" UUID NOT NULL,
    "editionId" UUID NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "currentSnapshotVersion" INTEGER NOT NULL,
    "departureDate" DATE NOT NULL,
    "returnDate" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "depositMinor" BIGINT NOT NULL,
    "balanceDueDate" DATE NOT NULL,
    "residenceCountry" CHAR(2) NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "requestExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "approvedAt" TIMESTAMPTZ(3),
    "approvalExpiresAt" TIMESTAMPTZ(3),
    "declinedAt" TIMESTAMPTZ(3),
    "expiredAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "statusReason" TEXT,
    "sourceChannel" "BookingSourceChannel" NOT NULL,
    "requestKeyHash" CHAR(64) NOT NULL,
    "requestConfigHash" CHAR(64) NOT NULL,
    "requestContactHmac" CHAR(64),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_snapshots" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" "BookingSnapshotKind" NOT NULL,
    "configuration" JSONB NOT NULL,
    "priceBreakdown" JSONB NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "depositMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_travellers" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "participationType" "ParticipationType" NOT NULL,
    "raceDistanceId" UUID,
    "isLead" BOOLEAN NOT NULL DEFAULT false,
    "addedInVersion" INTEGER NOT NULL DEFAULT 1,
    "removedInVersion" INTEGER,

    CONSTRAINT "booking_travellers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_rooms" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "roomOptionId" UUID NOT NULL,
    "occupancy" INTEGER NOT NULL,
    "travellerSlots" INTEGER[],

    CONSTRAINT "booking_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_extras" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "extraId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "travellerSlot" INTEGER,

    CONSTRAINT "booking_extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_claims" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "InventoryClaimStatus" NOT NULL DEFAULT 'held',
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_movements_bookingId_idx" ON "inventory_movements"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_userId_key" ON "customers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "customers_userId_userKind_key" ON "customers"("userId", "userKind");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");

-- CreateIndex
CREATE INDEX "bookings_customerId_status_idx" ON "bookings"("customerId", "status");

-- CreateIndex
CREATE INDEX "bookings_packageId_status_idx" ON "bookings"("packageId", "status");

-- CreateIndex
CREATE INDEX "bookings_editionId_status_idx" ON "bookings"("editionId", "status");

-- CreateIndex
CREATE INDEX "bookings_status_requestExpiresAt_idx" ON "bookings"("status", "requestExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_id_currency_key" ON "bookings"("id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_id_customerId_key" ON "bookings"("id", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_customerId_requestKeyHash_key" ON "bookings"("customerId", "requestKeyHash");

-- CreateIndex
CREATE INDEX "booking_snapshots_priceVersionId_idx" ON "booking_snapshots"("priceVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_snapshots_bookingId_version_key" ON "booking_snapshots"("bookingId", "version");

-- CreateIndex
CREATE INDEX "booking_travellers_customerId_idx" ON "booking_travellers"("customerId");

-- CreateIndex
CREATE INDEX "booking_travellers_raceDistanceId_idx" ON "booking_travellers"("raceDistanceId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_travellers_bookingId_slot_key" ON "booking_travellers"("bookingId", "slot");

-- CreateIndex
CREATE INDEX "booking_rooms_bookingId_idx" ON "booking_rooms"("bookingId");

-- CreateIndex
CREATE INDEX "booking_rooms_roomOptionId_idx" ON "booking_rooms"("roomOptionId");

-- CreateIndex
CREATE INDEX "booking_extras_extraId_idx" ON "booking_extras"("extraId");

-- CreateIndex (NULLS NOT DISTINCT: one row per per-booking extra, whose slot is NULL; plan 0.1, 1.2)
CREATE UNIQUE INDEX "booking_extras_booking_extra_slot_key" ON "booking_extras"("bookingId", "extraId", "travellerSlot") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "inventory_claims_poolId_status_idx" ON "inventory_claims"("poolId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_claims_bookingId_poolId_key" ON "inventory_claims"("bookingId", "poolId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_bookingId_customerId_fkey" FOREIGN KEY ("bookingId", "customerId") REFERENCES "bookings"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_userId_userKind_fkey" FOREIGN KEY ("userId", "userKind") REFERENCES "users"("id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_packageId_currency_fkey" FOREIGN KEY ("packageId", "currency") REFERENCES "packages"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_snapshots" ADD CONSTRAINT "booking_snapshots_bookingId_currency_fkey" FOREIGN KEY ("bookingId", "currency") REFERENCES "bookings"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_snapshots" ADD CONSTRAINT "booking_snapshots_priceVersionId_currency_fkey" FOREIGN KEY ("priceVersionId", "currency") REFERENCES "price_versions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_travellers" ADD CONSTRAINT "booking_travellers_bookingId_customerId_fkey" FOREIGN KEY ("bookingId", "customerId") REFERENCES "bookings"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_travellers" ADD CONSTRAINT "booking_travellers_raceDistanceId_fkey" FOREIGN KEY ("raceDistanceId") REFERENCES "race_distances"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_rooms" ADD CONSTRAINT "booking_rooms_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_rooms" ADD CONSTRAINT "booking_rooms_roomOptionId_fkey" FOREIGN KEY ("roomOptionId") REFERENCES "room_options"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_extras" ADD CONSTRAINT "booking_extras_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "booking_extras" ADD CONSTRAINT "booking_extras_extraId_fkey" FOREIGN KEY ("extraId") REFERENCES "extras"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_claims" ADD CONSTRAINT "inventory_claims_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_claims" ADD CONSTRAINT "inventory_claims_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "inventory_pools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints and triggers that Prisma cannot express (plan 2.4, section 3). Prisma ignores them when it compares the
-- schema with the migrations.

-- ---- Customers ----
-- Only a customer user can be linked; contact fields have a sane length; the link to a user is set once.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_user_kind_check" CHECK ("userKind" = 'customer'),
  ADD CONSTRAINT "customers_names_check" CHECK (char_length("givenName") BETWEEN 1 AND 100 AND char_length("familyName") BETWEEN 1 AND 100),
  ADD CONSTRAINT "customers_phone_check" CHECK ("phone" IS NULL OR "phone" ~ '^\+?[0-9 ]{6,20}$'),
  ADD CONSTRAINT "customers_country_check" CHECK ("countryOfResidence" ~ '^[A-Z]{2}$');

CREATE FUNCTION public.mt_customer_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_user = 'mt_privacy' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'a customer is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."isDemo" IS DISTINCT FROM OLD."isDemo"
     OR (OLD."userId" IS NOT NULL AND NEW."userId" IS DISTINCT FROM OLD."userId") THEN
    RAISE EXCEPTION 'a customer''s id, demo flag and linked user never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customers_guard BEFORE UPDATE OR DELETE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_guard();
CREATE TRIGGER customers_no_truncate BEFORE TRUNCATE ON "customers"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Bookings ----
-- Amounts never negative and the deposit within the total (plan 0.1, 1.1); a catalogue booking has its package (2.5
-- relaxes this for bespoke bookings); dates in order; a timestamp for each state that needs one.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_amounts_check" CHECK ("totalMinor" >= 0 AND "depositMinor" >= 0 AND "depositMinor" <= "totalMinor"),
  ADD CONSTRAINT "bookings_kind_check" CHECK ("kind" = 'catalogue'),
  ADD CONSTRAINT "bookings_dates_check" CHECK ("returnDate" >= "departureDate" AND "requestExpiresAt" > "requestedAt"),
  ADD CONSTRAINT "bookings_reference_check" CHECK ("reference" ~ '^MT-[0-9A-HJKMNP-TV-Z]{6}$'),
  ADD CONSTRAINT "bookings_country_check" CHECK ("residenceCountry" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "bookings_snapshot_version_check" CHECK ("currentSnapshotVersion" >= 1),
  ADD CONSTRAINT "bookings_status_reason_check" CHECK ("statusReason" IS NULL OR char_length("statusReason") BETWEEN 1 AND 500),
  ADD CONSTRAINT "bookings_state_times_check" CHECK (
    ("status" <> 'approved' OR ("approvedAt" IS NOT NULL AND "approvalExpiresAt" IS NOT NULL))
    AND ("status" <> 'declined' OR "declinedAt" IS NOT NULL)
    AND ("status" <> 'expired' OR "expiredAt" IS NOT NULL)
    AND ("status" <> 'cancelled' OR "cancelledAt" IS NOT NULL)
  );

-- Identity columns never change (plan 0.1, 5.10); a booking is created as a request at snapshot 1, its edition is its
-- package's; the status only moves along the pairs of plan 0.1, 6.2 (money pairs included, for 3.x), and every change of
-- status bumps the version; the snapshot version only goes up by one; never deleted.
CREATE FUNCTION public.mt_booking_guard() RETURNS trigger
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
      ('balance_paid', 'confirmed'), ('balance_paid', 'completed'), ('balance_paid', 'cancelled'),
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
CREATE TRIGGER bookings_guard BEFORE INSERT OR UPDATE OR DELETE ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_guard();
CREATE TRIGGER bookings_no_truncate BEFORE TRUNCATE ON "bookings"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- The totals of a booking always mirror its current snapshot (pricing rule: later price changes never alter it). Checked
-- at commit, so the booking and its first snapshot can be inserted in either order within one transaction.
CREATE FUNCTION public.mt_booking_mirrors_snapshot() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  b record;
BEGIN
  SELECT "currentSnapshotVersion", "totalMinor", "depositMinor", "currency" INTO b FROM public.bookings WHERE "id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_snapshots s
    WHERE s."bookingId" = NEW."id" AND s."version" = b."currentSnapshotVersion"
      AND s."totalMinor" = b."totalMinor" AND s."depositMinor" = b."depositMinor" AND s."currency" = b."currency"
  ) THEN
    RAISE EXCEPTION 'a booking''s totals must be those of its current snapshot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER bookings_mirror_snapshot AFTER INSERT OR UPDATE ON "bookings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_mirrors_snapshot();

-- ---- Snapshots: never change, for any role (plan 0.1, 4.9; not @appendOnly because they point at bookings) ----
ALTER TABLE "booking_snapshots"
  ADD CONSTRAINT "booking_snapshots_amounts_check" CHECK ("totalMinor" >= 0 AND "depositMinor" >= 0 AND "depositMinor" <= "totalMinor"),
  ADD CONSTRAINT "booking_snapshots_version_check" CHECK ("version" >= 1 AND (("kind" = 'original') = ("version" = 1))),
  ADD CONSTRAINT "booking_snapshots_json_check" CHECK (jsonb_typeof("configuration") = 'object' AND jsonb_typeof("priceBreakdown") = 'object');
CREATE TRIGGER booking_snapshots_append_only BEFORE UPDATE OR DELETE ON "booking_snapshots"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER booking_snapshots_no_truncate BEFORE TRUNCATE ON "booking_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Places, rooms and extras ----
ALTER TABLE "booking_travellers"
  ADD CONSTRAINT "booking_travellers_slot_check" CHECK ("slot" >= 1 AND "isLead" = ("slot" = 1)),
  ADD CONSTRAINT "booking_travellers_distance_check" CHECK (("participationType" = 'runner_with_entry') = ("raceDistanceId" IS NOT NULL)),
  ADD CONSTRAINT "booking_travellers_versions_check" CHECK ("addedInVersion" >= 1 AND ("removedInVersion" IS NULL OR "removedInVersion" > "addedInVersion"));
CREATE FUNCTION public.mt_booking_part_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'a % row is never deleted; amendments mark it removed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER booking_travellers_no_delete BEFORE DELETE ON "booking_travellers"
  FOR EACH ROW EXECUTE FUNCTION public.mt_booking_part_guard();
CREATE TRIGGER booking_travellers_no_truncate BEFORE TRUNCATE ON "booking_travellers"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
ALTER TABLE "booking_rooms"
  ADD CONSTRAINT "booking_rooms_occupancy_check" CHECK ("occupancy" BETWEEN 1 AND 4 AND cardinality("travellerSlots") = "occupancy");
ALTER TABLE "booking_extras"
  ADD CONSTRAINT "booking_extras_quantity_check" CHECK ("quantity" >= 1 AND ("travellerSlot" IS NULL OR ("travellerSlot" >= 1 AND "quantity" = 1)));

-- ---- Stock held by a booking: held → released once, never anything else (plan 0.1, 6.2) ----
ALTER TABLE "inventory_claims"
  ADD CONSTRAINT "inventory_claims_quantity_check" CHECK ("quantity" BETWEEN 1 AND 1000),
  ADD CONSTRAINT "inventory_claims_released_check" CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL));
CREATE FUNCTION public.mt_inventory_claim_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an inventory claim is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId" OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."quantity" IS DISTINCT FROM OLD."quantity" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR OLD."status" <> 'held' OR NEW."status" <> 'released' THEN
    RAISE EXCEPTION 'an inventory claim is only released, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_claims_guard BEFORE UPDATE OR DELETE ON "inventory_claims"
  FOR EACH ROW EXECUTE FUNCTION public.mt_inventory_claim_guard();
CREATE TRIGGER inventory_claims_no_truncate BEFORE TRUNCATE ON "inventory_claims"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Queues (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('bookings.maintenance', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
