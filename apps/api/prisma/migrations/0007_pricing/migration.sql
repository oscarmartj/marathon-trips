-- Task 2.1: pricing (price versions and their rates). Plan docs/plans/2.1-pricing-engine.md.

-- CreateEnum
CREATE TYPE "PriceVersionStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateTable
CREATE TABLE "price_versions" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "label" TEXT NOT NULL,
    "status" "PriceVersionStatus" NOT NULL DEFAULT 'draft',
    "validFrom" TIMESTAMPTZ(3),
    "validTo" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "price_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_rates" (
    "id" UUID NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "roomOptionId" UUID NOT NULL,
    "occupancy" INTEGER NOT NULL,
    "pricePerPersonMinor" BIGINT NOT NULL,
    "extraNightPerPersonMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "room_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participation_rates" (
    "id" UUID NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "participationType" "ParticipationType" NOT NULL,
    "raceDistanceId" UUID,
    "amountPerPersonMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "participation_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extra_rates" (
    "id" UUID NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "extraId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "extra_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_versions_packageId_status_idx" ON "price_versions"("packageId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "price_versions_id_currency_key" ON "price_versions"("id", "currency");

-- CreateIndex
CREATE INDEX "room_rates_roomOptionId_idx" ON "room_rates"("roomOptionId");

-- CreateIndex
CREATE UNIQUE INDEX "room_rates_priceVersionId_roomOptionId_occupancy_key" ON "room_rates"("priceVersionId", "roomOptionId", "occupancy");

-- CreateIndex
CREATE INDEX "participation_rates_raceDistanceId_idx" ON "participation_rates"("raceDistanceId");

-- CreateIndex (NULLS NOT DISTINCT: one rate per version and type when there is no distance; plan 0.1, 1.2; G3)
CREATE UNIQUE INDEX "participation_rates_version_type_distance_key" ON "participation_rates"("priceVersionId", "participationType", "raceDistanceId") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "extra_rates_extraId_idx" ON "extra_rates"("extraId");

-- CreateIndex
CREATE UNIQUE INDEX "extra_rates_priceVersionId_extraId_key" ON "extra_rates"("priceVersionId", "extraId");

-- AddForeignKey
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_packageId_currency_fkey" FOREIGN KEY ("packageId", "currency") REFERENCES "packages"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "room_rates" ADD CONSTRAINT "room_rates_priceVersionId_currency_fkey" FOREIGN KEY ("priceVersionId", "currency") REFERENCES "price_versions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "room_rates" ADD CONSTRAINT "room_rates_roomOptionId_fkey" FOREIGN KEY ("roomOptionId") REFERENCES "room_options"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "participation_rates" ADD CONSTRAINT "participation_rates_priceVersionId_currency_fkey" FOREIGN KEY ("priceVersionId", "currency") REFERENCES "price_versions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "participation_rates" ADD CONSTRAINT "participation_rates_raceDistanceId_fkey" FOREIGN KEY ("raceDistanceId") REFERENCES "race_distances"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "extra_rates" ADD CONSTRAINT "extra_rates_priceVersionId_currency_fkey" FOREIGN KEY ("priceVersionId", "currency") REFERENCES "price_versions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "extra_rates" ADD CONSTRAINT "extra_rates_extraId_fkey" FOREIGN KEY ("extraId") REFERENCES "extras"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Constraints and triggers that Prisma cannot express (plan 2.1, sections 1 and 12). Prisma ignores them when it
-- compares the schema with the migrations.

-- Money is whole minor units in the version's currency, never negative (plan 0.1, 1.1); the limit is A$1,000,000.
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "room_rates" ADD CONSTRAINT "room_rates_amounts_check"
  CHECK ("pricePerPersonMinor" >= 0 AND "pricePerPersonMinor" <= 100000000 AND "extraNightPerPersonMinor" >= 0 AND "extraNightPerPersonMinor" <= 100000000);
ALTER TABLE "room_rates" ADD CONSTRAINT "room_rates_occupancy_check" CHECK ("occupancy" BETWEEN 1 AND 4);
ALTER TABLE "participation_rates" ADD CONSTRAINT "participation_rates_amount_check" CHECK ("amountPerPersonMinor" >= 0 AND "amountPerPersonMinor" <= 100000000);
-- A distance if and only if the traveller is a runner with an entry (G3).
ALTER TABLE "participation_rates" ADD CONSTRAINT "participation_rates_distance_iff_entry_check"
  CHECK (("participationType" = 'runner_with_entry') = ("raceDistanceId" IS NOT NULL));
ALTER TABLE "extra_rates" ADD CONSTRAINT "extra_rates_amount_check" CHECK ("amountMinor" >= 0 AND "amountMinor" <= 100000000);

-- A draft has no validity; a published version has a start; only a published version has an end, never before its start.
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_validity_check" CHECK (
  ("status" = 'published' AND "validFrom" IS NOT NULL AND ("validTo" IS NULL OR "validTo" >= "validFrom"))
  OR ("status" <> 'published' AND "validFrom" IS NULL AND "validTo" IS NULL));
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_label_check" CHECK (btrim("label") <> '' AND length("label") <= 100);
-- Two published versions of one package never overlap (plan 0.1, 5.3).
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_no_overlap"
  EXCLUDE USING gist ("packageId" WITH =, tstzrange("validFrom", "validTo", '[)') WITH &&) WHERE ("status" = 'published');

-- A price version: identity never changes; a draft may be published or discarded; a published version only gets its
-- validTo, once, not in the past; an archived (discarded) draft never changes again (M1, money identity).
CREATE FUNCTION public.mt_pricing_version_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'draft' THEN
      RAISE EXCEPTION 'only a draft price version can be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."packageId" IS DISTINCT FROM OLD."packageId" OR NEW."currency" IS DISTINCT FROM OLD."currency" THEN
    RAISE EXCEPTION 'the package and currency of a price version never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'draft' THEN
    -- Columns keep milliseconds, now() keeps microseconds: a start rounded to the millisecond is still "now".
    IF NEW."status" = 'published' AND NEW."validFrom" < now() - interval '1 millisecond' THEN
      RAISE EXCEPTION 'a price version cannot be published in the past' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'published' THEN
    IF NEW."status" <> 'published' OR NEW."label" IS DISTINCT FROM OLD."label" OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom"
       OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" OR NEW."publishedById" IS DISTINCT FROM OLD."publishedById" OR NEW."version" IS DISTINCT FROM OLD."version" THEN
      RAISE EXCEPTION 'a published price version is frozen; only its end is set, once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."validTo" IS DISTINCT FROM OLD."validTo" THEN
      IF OLD."validTo" IS NOT NULL OR NEW."validTo" IS NULL OR NEW."validTo" < now() - interval '1 millisecond' THEN
        RAISE EXCEPTION 'the end of a published price version is set once and not in the past' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an archived price version never changes' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER price_versions_guard BEFORE UPDATE OR DELETE ON "price_versions"
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_version_guard();
CREATE TRIGGER price_versions_no_truncate BEFORE TRUNCATE ON "price_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Closing a published version without a published successor that starts where it ends would leave the package
-- without a price: checked at commit (M1).
CREATE FUNCTION public.mt_pricing_version_successor() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."status" = 'published' AND OLD."validTo" IS NULL AND NEW."validTo" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "price_versions" s
    WHERE s."packageId" = NEW."packageId" AND s."id" <> NEW."id" AND s."status" = 'published' AND s."validFrom" = NEW."validTo"
  ) THEN
    RAISE EXCEPTION 'a published price version ends only when a published successor starts' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER price_versions_successor AFTER UPDATE ON "price_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_version_successor();

-- Rates: only a draft's rates change, read with FOR SHARE so a publish waits for (or blocks) a rate edit (M2); the
-- version and currency of a rate never change; what a rate prices belongs to the version's package.
CREATE FUNCTION public.mt_pricing_rate_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_status "PriceVersionStatus";
  v_package uuid;
  ok boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."priceVersionId" IS DISTINCT FROM OLD."priceVersionId" OR NEW."currency" IS DISTINCT FROM OLD."currency") THEN
    RAISE EXCEPTION 'the version and currency of a rate never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT "status", "packageId" INTO v_status, v_package FROM "price_versions"
    WHERE "id" = (CASE WHEN TG_OP = 'DELETE' THEN OLD."priceVersionId" ELSE NEW."priceVersionId" END) FOR SHARE;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'only the rates of a draft price version can change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'room_rates' THEN
    SELECT EXISTS (SELECT 1 FROM "room_options" ro JOIN "package_hotels" ph ON ph."id" = ro."packageHotelId"
                   WHERE ro."id" = NEW."roomOptionId" AND ph."packageId" = v_package) INTO ok;
  ELSIF TG_TABLE_NAME = 'extra_rates' THEN
    SELECT EXISTS (SELECT 1 FROM "extras" x WHERE x."id" = NEW."extraId" AND x."packageId" = v_package) INTO ok;
  ELSE
    SELECT NEW."raceDistanceId" IS NULL OR EXISTS (
      SELECT 1 FROM "race_distances" d JOIN "race_editions" e ON e."raceId" = d."raceId" JOIN "packages" p ON p."editionId" = e."id"
      WHERE d."id" = NEW."raceDistanceId" AND p."id" = v_package) INTO ok;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'a rate can only price what belongs to its package' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER room_rates_guard BEFORE INSERT OR UPDATE OR DELETE ON "room_rates"
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_rate_guard();
CREATE TRIGGER participation_rates_guard BEFORE INSERT OR UPDATE OR DELETE ON "participation_rates"
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_rate_guard();
CREATE TRIGGER extra_rates_guard BEFORE INSERT OR UPDATE OR DELETE ON "extra_rates"
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_rate_guard();
CREATE TRIGGER room_rates_no_truncate BEFORE TRUNCATE ON "room_rates"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER participation_rates_no_truncate BEFORE TRUNCATE ON "participation_rates"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER extra_rates_no_truncate BEFORE TRUNCATE ON "extra_rates"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
