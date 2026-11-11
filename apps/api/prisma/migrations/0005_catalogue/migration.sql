-- Task 1.1: catalogue (races, editions, packages, hotels, rooms, extras, inventory).

-- CreateEnum
CREATE TYPE "RaceType" AS ENUM ('road', 'trail', 'ultra', 'other');

-- CreateEnum
CREATE TYPE "RaceStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "DistanceKind" AS ENUM ('marathon', 'half', 'ten_k', 'five_k', 'ultra', 'other');

-- CreateEnum
CREATE TYPE "RaceClaimKind" AS ENUM ('official_partner', 'accredited_agent', 'guaranteed_entry', 'other');

-- CreateEnum
CREATE TYPE "DateStatus" AS ENUM ('provisional', 'confirmed');

-- CreateEnum
CREATE TYPE "EditionStatus" AS ENUM ('draft', 'announced', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('draft', 'coming_soon', 'open', 'waitlist', 'sold_out', 'closed');

-- CreateEnum
CREATE TYPE "DepositMode" AS ENUM ('per_person', 'per_booking', 'percent');

-- CreateEnum
CREATE TYPE "ParticipationType" AS ENUM ('runner_with_entry', 'runner_own_entry', 'supporter');

-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('single', 'twin', 'double', 'triple', 'quad', 'other');

-- CreateEnum
CREATE TYPE "ExtraKind" AS ENUM ('excursion', 'transfer', 'meal', 'merchandise', 'other');

-- CreateEnum
CREATE TYPE "PricingUnit" AS ENUM ('per_person', 'per_booking');

-- CreateEnum
CREATE TYPE "ExtraAudience" AS ENUM ('all', 'runners', 'supporters');

-- CreateEnum
CREATE TYPE "PoolKind" AS ENUM ('entry', 'room', 'extra');

-- CreateEnum
CREATE TYPE "InventoryReason" AS ENUM ('hold', 'release', 'capacity_change', 'adjustment');

-- CreateTable
CREATE TABLE "races" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "city" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "raceType" "RaceType" NOT NULL,
    "typicalMonth" INTEGER,
    "summary" JSONB NOT NULL,
    "websiteUrl" TEXT,
    "latitudeE7" INTEGER,
    "longitudeE7" INTEGER,
    "seo" JSONB NOT NULL DEFAULT '{}',
    "status" "RaceStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMPTZ(3),
    "externalSource" TEXT,
    "externalId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "races_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_distances" (
    "id" UUID NOT NULL,
    "raceId" UUID NOT NULL,
    "kind" "DistanceKind" NOT NULL,
    "distanceMetres" INTEGER NOT NULL,
    "name" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "race_distances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_claims" (
    "id" UUID NOT NULL,
    "raceId" UUID NOT NULL,
    "kind" "RaceClaimKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "evidenceNote" TEXT NOT NULL DEFAULT '',
    "enabledById" UUID,
    "enabledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "race_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_editions" (
    "id" UUID NOT NULL,
    "raceId" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "dateStatus" "DateStatus" NOT NULL DEFAULT 'provisional',
    "status" "EditionStatus" NOT NULL DEFAULT 'draft',
    "notes" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "race_editions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packages" (
    "id" UUID NOT NULL,
    "editionId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "saleStatus" "SaleStatus" NOT NULL DEFAULT 'draft',
    "checkInDate" DATE NOT NULL,
    "checkOutDate" DATE NOT NULL,
    "includes" JSONB NOT NULL,
    "excludes" JSONB NOT NULL,
    "instantBooking" BOOLEAN NOT NULL DEFAULT false,
    "autoConfirmOnDeposit" BOOLEAN NOT NULL DEFAULT true,
    "depositMode" "DepositMode",
    "depositAmountMinor" BIGINT,
    "depositBps" INTEGER,
    "balanceDueDate" DATE NOT NULL,
    "minTravellers" INTEGER NOT NULL DEFAULT 1,
    "maxTravellers" INTEGER NOT NULL,
    "maxExtraNightsBefore" INTEGER NOT NULL DEFAULT 0,
    "maxExtraNightsAfter" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'AUD',
    "seo" JSONB NOT NULL DEFAULT '{}',
    "publishedAt" TIMESTAMPTZ(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_participation_options" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "type" "ParticipationType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "package_participation_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_entry_options" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "raceDistanceId" UUID NOT NULL,
    "entryPoolId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "package_entry_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hotels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "starRating" INTEGER,
    "description" JSONB NOT NULL,
    "supplierId" UUID,
    "latitudeE7" INTEGER,
    "longitudeE7" INTEGER,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "hotels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_hotels" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "hotelId" UUID NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "package_hotels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_options" (
    "id" UUID NOT NULL,
    "packageHotelId" UUID NOT NULL,
    "roomType" "RoomType" NOT NULL,
    "name" JSONB NOT NULL,
    "minOccupancy" INTEGER NOT NULL,
    "maxOccupancy" INTEGER NOT NULL,
    "roomPoolId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "room_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extras" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "kind" "ExtraKind" NOT NULL,
    "name" JSONB NOT NULL,
    "description" JSONB NOT NULL,
    "pricingUnit" "PricingUnit" NOT NULL,
    "availableTo" "ExtraAudience" NOT NULL DEFAULT 'all',
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "maxPerBooking" INTEGER,
    "poolId" UUID,
    "schedule" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_pools" (
    "id" UUID NOT NULL,
    "editionId" UUID NOT NULL,
    "kind" "PoolKind" NOT NULL,
    "label" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "consumed" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER,
    "confirmedBySupplier" BOOLEAN NOT NULL DEFAULT false,
    "confirmationNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "inventory_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "InventoryReason" NOT NULL,
    "bookingId" UUID,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" UUID,
    "auditLogId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "races_slug_key" ON "races"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "races_externalSource_externalId_key" ON "races"("externalSource", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "race_claims_raceId_kind_key" ON "race_claims"("raceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "race_editions_raceId_year_key" ON "race_editions"("raceId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "packages_editionId_slug_key" ON "packages"("editionId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "packages_id_currency_key" ON "packages"("id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "package_participation_options_packageId_type_key" ON "package_participation_options"("packageId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "package_entry_options_packageId_raceDistanceId_key" ON "package_entry_options"("packageId", "raceDistanceId");

-- CreateIndex
CREATE UNIQUE INDEX "package_hotels_packageId_hotelId_key" ON "package_hotels"("packageId", "hotelId");

-- CreateIndex
CREATE INDEX "races_status_idx" ON "races"("status");

-- CreateIndex
CREATE INDEX "race_distances_raceId_idx" ON "race_distances"("raceId");

-- CreateIndex
CREATE INDEX "race_editions_status_idx" ON "race_editions"("status");

-- CreateIndex
CREATE INDEX "packages_saleStatus_idx" ON "packages"("saleStatus");

-- CreateIndex
CREATE INDEX "package_entry_options_entryPoolId_idx" ON "package_entry_options"("entryPoolId");

-- CreateIndex
CREATE INDEX "package_hotels_hotelId_idx" ON "package_hotels"("hotelId");

-- CreateIndex
CREATE INDEX "room_options_packageHotelId_idx" ON "room_options"("packageHotelId");

-- CreateIndex
CREATE INDEX "room_options_roomPoolId_idx" ON "room_options"("roomPoolId");

-- CreateIndex
CREATE INDEX "extras_packageId_idx" ON "extras"("packageId");

-- CreateIndex
CREATE INDEX "extras_poolId_idx" ON "extras"("poolId");

-- CreateIndex
CREATE INDEX "inventory_pools_editionId_idx" ON "inventory_pools"("editionId");

-- CreateIndex
CREATE INDEX "inventory_movements_poolId_createdAt_idx" ON "inventory_movements"("poolId", "createdAt");

-- AddForeignKey
ALTER TABLE "race_distances" ADD CONSTRAINT "race_distances_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "race_claims" ADD CONSTRAINT "race_claims_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "race_editions" ADD CONSTRAINT "race_editions_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "packages" ADD CONSTRAINT "packages_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_participation_options" ADD CONSTRAINT "package_participation_options_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_entry_options" ADD CONSTRAINT "package_entry_options_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_entry_options" ADD CONSTRAINT "package_entry_options_raceDistanceId_fkey" FOREIGN KEY ("raceDistanceId") REFERENCES "race_distances"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_entry_options" ADD CONSTRAINT "package_entry_options_entryPoolId_fkey" FOREIGN KEY ("entryPoolId") REFERENCES "inventory_pools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_hotels" ADD CONSTRAINT "package_hotels_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "package_hotels" ADD CONSTRAINT "package_hotels_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "room_options" ADD CONSTRAINT "room_options_packageHotelId_fkey" FOREIGN KEY ("packageHotelId") REFERENCES "package_hotels"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "room_options" ADD CONSTRAINT "room_options_roomPoolId_fkey" FOREIGN KEY ("roomPoolId") REFERENCES "inventory_pools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "extras" ADD CONSTRAINT "extras_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "extras" ADD CONSTRAINT "extras_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "inventory_pools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_pools" ADD CONSTRAINT "inventory_pools_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "inventory_pools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Constraints, triggers and grants that Prisma cannot express (plan 1.1, section 2). Prisma ignores them when it
-- compares the schema with the migrations.

ALTER TABLE "races" ADD CONSTRAINT "races_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "races" ADD CONSTRAINT "races_country_code_check" CHECK ("countryCode" ~ '^[A-Z]{2}$');
ALTER TABLE "races" ADD CONSTRAINT "races_typical_month_check" CHECK ("typicalMonth" IS NULL OR "typicalMonth" BETWEEN 1 AND 12);
ALTER TABLE "races" ADD CONSTRAINT "races_latitude_check" CHECK ("latitudeE7" IS NULL OR "latitudeE7" BETWEEN -900000000 AND 900000000);
ALTER TABLE "races" ADD CONSTRAINT "races_longitude_check" CHECK ("longitudeE7" IS NULL OR "longitudeE7" BETWEEN -1800000000 AND 1800000000);
ALTER TABLE "races" ADD CONSTRAINT "races_external_pair_check" CHECK (("externalSource" IS NULL) = ("externalId" IS NULL));
-- Demo data is never published, whatever APP_ENV says (plan 6.1).
ALTER TABLE "races" ADD CONSTRAINT "races_demo_never_published_check" CHECK (NOT ("isDemo" AND "status" = 'published'));
ALTER TABLE "race_distances" ADD CONSTRAINT "race_distances_metres_check" CHECK ("distanceMetres" > 0);
ALTER TABLE "race_claims" ADD CONSTRAINT "race_claims_enabled_needs_evidence_check"
  CHECK (NOT "enabled" OR ("enabledAt" IS NOT NULL AND btrim("evidenceNote") <> ''));
ALTER TABLE "race_editions" ADD CONSTRAINT "race_editions_year_check" CHECK ("year" BETWEEN 2000 AND 2200);
ALTER TABLE "race_editions" ADD CONSTRAINT "race_editions_dates_check" CHECK ("endDate" IS NULL OR "startDate" IS NULL OR "endDate" >= "startDate");
ALTER TABLE "race_editions" ADD CONSTRAINT "race_editions_confirmed_needs_date_check" CHECK ("dateStatus" <> 'confirmed' OR "startDate" IS NOT NULL);

ALTER TABLE "packages" ADD CONSTRAINT "packages_slug_format_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "packages" ADD CONSTRAINT "packages_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "packages" ADD CONSTRAINT "packages_stay_dates_check" CHECK ("checkOutDate" > "checkInDate");
ALTER TABLE "packages" ADD CONSTRAINT "packages_balance_due_check" CHECK ("balanceDueDate" <= "checkInDate");
ALTER TABLE "packages" ADD CONSTRAINT "packages_travellers_check" CHECK ("minTravellers" >= 1 AND "maxTravellers" >= "minTravellers");
ALTER TABLE "packages" ADD CONSTRAINT "packages_extra_nights_check" CHECK ("maxExtraNightsBefore" BETWEEN 0 AND 30 AND "maxExtraNightsAfter" BETWEEN 0 AND 30);
-- Money is whole minor units in `currency`; the deposit is a fixed amount or basis points, never both (plan 1.1).
ALTER TABLE "packages" ADD CONSTRAINT "packages_deposit_amount_check" CHECK ("depositAmountMinor" IS NULL OR "depositAmountMinor" >= 0);
ALTER TABLE "packages" ADD CONSTRAINT "packages_deposit_bps_check" CHECK ("depositBps" IS NULL OR "depositBps" BETWEEN 1 AND 10000);
ALTER TABLE "packages" ADD CONSTRAINT "packages_deposit_shape_check" CHECK (
  ("depositMode" IS NULL AND "depositAmountMinor" IS NULL AND "depositBps" IS NULL)
  OR ("depositMode" IN ('per_person', 'per_booking') AND "depositAmountMinor" IS NOT NULL AND "depositBps" IS NULL)
  OR ("depositMode" = 'percent' AND "depositBps" IS NOT NULL AND "depositAmountMinor" IS NULL));
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_country_code_check" CHECK ("countryCode" ~ '^[A-Z]{2}$');
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_star_rating_check" CHECK ("starRating" IS NULL OR "starRating" BETWEEN 1 AND 5);
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_latitude_check" CHECK ("latitudeE7" IS NULL OR "latitudeE7" BETWEEN -900000000 AND 900000000);
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_longitude_check" CHECK ("longitudeE7" IS NULL OR "longitudeE7" BETWEEN -1800000000 AND 1800000000);
ALTER TABLE "room_options" ADD CONSTRAINT "room_options_occupancy_check" CHECK (1 <= "minOccupancy" AND "minOccupancy" <= "maxOccupancy" AND "maxOccupancy" <= 4);
ALTER TABLE "extras" ADD CONSTRAINT "extras_max_per_booking_check" CHECK ("maxPerBooking" IS NULL OR "maxPerBooking" > 0);
-- A pool can never go below zero or above its capacity, whatever the code does (plan 1.2).
ALTER TABLE "inventory_pools" ADD CONSTRAINT "inventory_pools_capacity_check" CHECK ("capacity" >= 0 AND "consumed" BETWEEN 0 AND "capacity");
ALTER TABLE "inventory_pools" ADD CONSTRAINT "inventory_pools_low_stock_check" CHECK ("lowStockThreshold" IS NULL OR "lowStockThreshold" >= 0);
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_delta_check" CHECK ("delta" <> 0);

-- isDemo is set when a row is created (the seed) and never changes.
CREATE FUNCTION public.mt_catalogue_demo_flag_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."isDemo" IS DISTINCT FROM OLD."isDemo" THEN
    RAISE EXCEPTION 'isDemo cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER races_demo_flag_immutable BEFORE UPDATE ON "races"
  FOR EACH ROW EXECUTE FUNCTION public.mt_catalogue_demo_flag_immutable();
CREATE TRIGGER hotels_demo_flag_immutable BEFORE UPDATE ON "hotels"
  FOR EACH ROW EXECUTE FUNCTION public.mt_catalogue_demo_flag_immutable();

-- A package of a demo race never leaves draft (plan 6.1); a hotel is linked only to a package with the same isDemo.
CREATE FUNCTION public.mt_catalogue_demo_package_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."saleStatus" <> 'draft' AND EXISTS (
    SELECT 1 FROM "race_editions" e JOIN "races" r ON r."id" = e."raceId" WHERE e."id" = NEW."editionId" AND r."isDemo"
  ) THEN
    RAISE EXCEPTION 'a demo package cannot leave draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER packages_demo_never_on_sale BEFORE INSERT OR UPDATE ON "packages"
  FOR EACH ROW EXECUTE FUNCTION public.mt_catalogue_demo_package_guard();

CREATE FUNCTION public.mt_catalogue_hotel_demo_match() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (SELECT h."isDemo" FROM "hotels" h WHERE h."id" = NEW."hotelId") IS DISTINCT FROM (
    SELECT r."isDemo" FROM "packages" p JOIN "race_editions" e ON e."id" = p."editionId" JOIN "races" r ON r."id" = e."raceId" WHERE p."id" = NEW."packageId"
  ) THEN
    RAISE EXCEPTION 'hotel and package must both be demo or both be real' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER package_hotels_demo_match BEFORE INSERT OR UPDATE ON "package_hotels"
  FOR EACH ROW EXECUTE FUNCTION public.mt_catalogue_hotel_demo_match();

-- The stock history is never edited: a correction is a new, compensating movement (plan 5.2).
CREATE TRIGGER inventory_movements_immutable BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER inventory_movements_no_truncate BEFORE TRUNCATE ON "inventory_movements"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
REVOKE UPDATE, DELETE ON "inventory_movements" FROM mt_app;
