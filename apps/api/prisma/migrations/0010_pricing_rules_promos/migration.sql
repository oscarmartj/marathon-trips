-- Task 2.2: price rules, promo codes and their redemptions, scheduled price versions and the price terms a version
-- was published with. Plan docs/plans/2.2-pricing-rules-promo-codes.md.

-- CreateEnum
CREATE TYPE "PriceRuleScope" AS ENUM ('global', 'edition', 'package');

-- CreateEnum
CREATE TYPE "PriceRuleKind" AS ENUM ('early_bird', 'late_supplement', 'group_discount', 'occupancy_supplement', 'custom');

-- CreateEnum
CREATE TYPE "PriceRuleDirection" AS ENUM ('discount', 'surcharge');

-- CreateEnum
CREATE TYPE "PriceEffectMode" AS ENUM ('percent', 'fixed');

-- CreateEnum
CREATE TYPE "PriceEffectPer" AS ENUM ('person', 'booking');

-- CreateEnum
CREATE TYPE "PriceEffectTarget" AS ENUM ('accommodation', 'participation', 'extras', 'subtotal');

-- AlterTable
ALTER TABLE "price_versions" ADD COLUMN     "pricedTerms" JSONB;

-- CreateTable
CREATE TABLE "price_rules" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "scopeType" "PriceRuleScope" NOT NULL,
    "editionId" UUID,
    "packageId" UUID,
    "kind" "PriceRuleKind" NOT NULL,
    "direction" "PriceRuleDirection" NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "effectMode" "PriceEffectMode" NOT NULL,
    "valueBps" INTEGER,
    "valueMinor" BIGINT,
    "currency" CHAR(3),
    "per" "PriceEffectPer" NOT NULL,
    "appliesTo" "PriceEffectTarget" NOT NULL,
    "priority" INTEGER NOT NULL,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL,
    "validFrom" TIMESTAMPTZ(3),
    "validTo" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" UUID NOT NULL,
    "code" CITEXT NOT NULL,
    "label" TEXT NOT NULL,
    "scopeType" "PriceRuleScope" NOT NULL,
    "editionId" UUID,
    "packageId" UUID,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "effectMode" "PriceEffectMode" NOT NULL,
    "valueBps" INTEGER,
    "valueMinor" BIGINT,
    "currency" CHAR(3),
    "per" "PriceEffectPer" NOT NULL,
    "appliesTo" "PriceEffectTarget" NOT NULL,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL,
    "validFrom" TIMESTAMPTZ(3),
    "validTo" TIMESTAMPTZ(3),
    "maxRedemptions" INTEGER,
    "maxPerCustomer" INTEGER,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_redemptions" (
    "id" UUID NOT NULL,
    "promoCodeId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "activeBookingId" UUID,
    "redeemedAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "price_rules_scopeType_idx" ON "price_rules"("scopeType");

-- CreateIndex
CREATE INDEX "price_rules_editionId_idx" ON "price_rules"("editionId");

-- CreateIndex
CREATE INDEX "price_rules_packageId_idx" ON "price_rules"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "promo_codes"("code");

-- CreateIndex
CREATE INDEX "promo_codes_editionId_idx" ON "promo_codes"("editionId");

-- CreateIndex
CREATE INDEX "promo_codes_packageId_idx" ON "promo_codes"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_activeBookingId_key" ON "promo_redemptions"("activeBookingId");

-- CreateIndex
CREATE INDEX "promo_redemptions_promoCodeId_customerId_idx" ON "promo_redemptions"("promoCodeId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "promo_redemptions_promoCodeId_bookingId_key" ON "promo_redemptions"("promoCodeId", "bookingId");

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints and triggers that Prisma cannot express (plan 2.2, sections 3 to 8). Prisma ignores them when it
-- compares the schema with the migrations.

-- ---- Rules and codes: scope, effect and validity ----
-- The scope names exactly the columns it needs (plan 2.2, section 3).
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_scope_check" CHECK (
  ("scopeType" = 'global' AND "editionId" IS NULL AND "packageId" IS NULL)
  OR ("scopeType" = 'edition' AND "editionId" IS NOT NULL AND "packageId" IS NULL)
  OR ("scopeType" = 'package' AND "packageId" IS NOT NULL AND "editionId" IS NULL));
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_scope_check" CHECK (
  ("scopeType" = 'global' AND "editionId" IS NULL AND "packageId" IS NULL)
  OR ("scopeType" = 'edition' AND "editionId" IS NOT NULL AND "packageId" IS NULL)
  OR ("scopeType" = 'package' AND "packageId" IS NOT NULL AND "editionId" IS NULL));
-- A percentage has basis points and no amount and is per booking; a fixed effect has an amount and its currency. Amounts
-- and basis points are never negative: the direction gives the sign (plan 0.1, 1.1). An amount per person is at most
-- A$1,000,000 / 80 travellers, per booking at most A$1,000,000 (plan 2.2, section 15, point 10).
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_effect_check" CHECK (
  ("effectMode" = 'percent' AND "valueBps" IS NOT NULL AND "valueMinor" IS NULL AND "currency" IS NULL AND "per" = 'booking'
    AND "valueBps" >= 0 AND "valueBps" <= (CASE WHEN "direction" = 'discount' THEN 10000 ELSE 100000 END))
  OR ("effectMode" = 'fixed' AND "valueBps" IS NULL AND "valueMinor" IS NOT NULL AND "currency" IS NOT NULL
    AND "valueMinor" >= 0 AND "valueMinor" <= (CASE WHEN "per" = 'person' THEN 1250000 ELSE 100000000 END)));
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_effect_check" CHECK (
  ("effectMode" = 'percent' AND "valueBps" IS NOT NULL AND "valueMinor" IS NULL AND "currency" IS NULL AND "per" = 'booking'
    AND "valueBps" >= 0 AND "valueBps" <= 10000)
  OR ("effectMode" = 'fixed' AND "valueBps" IS NULL AND "valueMinor" IS NOT NULL AND "currency" IS NOT NULL
    AND "valueMinor" >= 0 AND "valueMinor" <= (CASE WHEN "per" = 'person' THEN 1250000 ELSE 100000000 END)));
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_currency_check" CHECK (("valueMinor" IS NULL) = ("currency" IS NULL) AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'));
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_currency_check" CHECK (("valueMinor" IS NULL) = ("currency" IS NULL) AND ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'));
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_validity_check" CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validTo" > "validFrom");
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_validity_check" CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validTo" > "validFrom");
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_priority_check" CHECK ("priority" BETWEEN 0 AND 1000);
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_label_check" CHECK (btrim("label") <> '' AND length("label") <= 80);
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_label_check" CHECK (btrim("label") <> '' AND length("label") <= 80);
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_conditions_check" CHECK (jsonb_typeof("conditions") = 'object');
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_conditions_check" CHECK (jsonb_typeof("conditions") = 'object');
-- The code as stored: upper case, letters, digits and inner hyphens, 6 to 32 characters (PROMO_CODE_PATTERN).
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_code_check" CHECK ("code"::text ~ '^[A-Z0-9][A-Z0-9-]{4,30}[A-Z0-9]$');
-- Limits: at least 1 when set; the active redemptions never go below 0 or above the maximum (plan 0.1, 1.2).
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_limits_check" CHECK (
  ("maxRedemptions" IS NULL OR "maxRedemptions" >= 1) AND ("maxPerCustomer" IS NULL OR "maxPerCustomer" >= 1));
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_redeemed_check" CHECK (
  "redeemedCount" >= 0 AND ("maxRedemptions" IS NULL OR "redeemedCount" <= "maxRedemptions"));

-- A fixed effect scoped to a package or an edition is in that package's (every package's of that edition) currency;
-- the scope of a rule or code, and the text of a code, never change; neither is ever deleted; an archived rule never
-- changes, and an archived code only gives back redemptions (plan 2.2, sections 3 and 4).
CREATE FUNCTION public.mt_pricing_adjustment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a % is archived, never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."scopeType" IS DISTINCT FROM OLD."scopeType"
       OR NEW."editionId" IS DISTINCT FROM OLD."editionId" OR NEW."packageId" IS DISTINCT FROM OLD."packageId" THEN
      RAISE EXCEPTION 'the scope of a rule or code never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Through jsonb: price_rules has no code column, and PL/pgSQL would fail on NEW."code" for it.
    IF TG_TABLE_NAME = 'promo_codes' AND (to_jsonb(NEW) ->> 'code') IS DISTINCT FROM (to_jsonb(OLD) ->> 'code') THEN
      RAISE EXCEPTION 'the text of a promo code never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD."archivedAt" IS NOT NULL THEN
      IF TG_TABLE_NAME = 'promo_codes'
         AND (to_jsonb(NEW) - 'redeemedCount' - 'updatedAt') = (to_jsonb(OLD) - 'redeemedCount' - 'updatedAt')
         AND (to_jsonb(NEW) ->> 'redeemedCount')::int < (to_jsonb(OLD) ->> 'redeemedCount')::int THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'an archived rule or code never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW."currency" IS NOT NULL THEN
    IF NEW."packageId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "packages" p WHERE p."id" = NEW."packageId" AND p."currency" = NEW."currency") THEN
      RAISE EXCEPTION 'a fixed amount must be in the currency of its package' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."editionId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "packages" p WHERE p."editionId" = NEW."editionId" AND p."deletedAt" IS NULL AND p."currency" <> NEW."currency") THEN
      RAISE EXCEPTION 'a fixed amount must be in the currency of every package of its edition' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER price_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON "price_rules"
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_adjustment_guard();
CREATE TRIGGER promo_codes_guard BEFORE INSERT OR UPDATE OR DELETE ON "promo_codes"
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_adjustment_guard();
CREATE TRIGGER price_rules_no_truncate BEFORE TRUNCATE ON "price_rules"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER promo_codes_no_truncate BEFORE TRUNCATE ON "promo_codes"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Redemptions (plan 2.2, section 8) ----
-- Active while releasedAt is null; activeBookingId mirrors bookingId while active, so its unique index allows one active
-- redemption per booking (section 15, point 3).
ALTER TABLE "promo_redemptions" ADD CONSTRAINT "promo_redemptions_active_check" CHECK (
  ("releasedAt" IS NULL) = ("activeBookingId" IS NOT NULL) AND ("activeBookingId" IS NULL OR "activeBookingId" = "bookingId")
  AND ("releasedAt" IS NULL OR "releasedAt" >= "redeemedAt"));
-- Only the release changes, once; a redemption is never deleted.
CREATE FUNCTION public.mt_promo_redemption_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a promo redemption is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."promoCodeId" IS DISTINCT FROM OLD."promoCodeId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."redeemedAt" IS DISTINCT FROM OLD."redeemedAt"
     OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL OR NEW."activeBookingId" IS NOT NULL THEN
    RAISE EXCEPTION 'a promo redemption is only released, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER promo_redemptions_guard BEFORE UPDATE OR DELETE ON "promo_redemptions"
  FOR EACH ROW EXECUTE FUNCTION public.mt_promo_redemption_guard();
CREATE TRIGGER promo_redemptions_no_truncate BEFORE TRUNCATE ON "promo_redemptions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Price versions: scheduled versions, withdrawal and the price terms (plan 2.2, sections 5 and 6) ----
-- Existing published versions get the price terms of the catalogue as it is, so a package on sale keeps passing the
-- open gate; the guard is off only for this statement. A package without extras gets [] (section 15, point 4).
ALTER TABLE "price_versions" DISABLE TRIGGER "price_versions_guard";
UPDATE "price_versions" v SET "pricedTerms" = (
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'extraId', e."id", 'pricingUnit', e."pricingUnit"::text, 'mandatory', e."mandatory",
           'availableTo', CASE WHEN e."mandatory" THEN e."availableTo"::text ELSE NULL END) ORDER BY e."id"), '[]'::jsonb)
  FROM "extras" e WHERE e."packageId" = v."packageId" AND e."deletedAt" IS NULL)
WHERE v."status" = 'published';
ALTER TABLE "price_versions" ENABLE TRIGGER "price_versions_guard";

-- A withdrawn version (published, never started, then archived) keeps its start and its terms; a discarded draft has none.
ALTER TABLE "price_versions" DROP CONSTRAINT "price_versions_validity_check";
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_validity_check" CHECK (
  ("status" = 'published' AND "validFrom" IS NOT NULL AND ("validTo" IS NULL OR "validTo" >= "validFrom"))
  OR ("status" = 'draft' AND "validFrom" IS NULL AND "validTo" IS NULL)
  OR ("status" = 'archived' AND "validTo" IS NULL AND (("publishedAt" IS NULL AND "validFrom" IS NULL) OR ("publishedAt" IS NOT NULL AND "validFrom" IS NOT NULL))));
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_priced_terms_check" CHECK (
  ("status" <> 'published' OR "pricedTerms" IS NOT NULL) AND ("pricedTerms" IS NULL OR jsonb_typeof("pricedTerms") = 'array'));

-- The guard of 2.1, plus: a published version that has not started may be withdrawn (archived, nothing else changes);
-- its predecessor's end, still in the future, may go back to null; the price terms never change once published. The
-- new checks read clock_timestamp(), not now(), which is the start of the transaction (section 15, point 5).
CREATE OR REPLACE FUNCTION public.mt_pricing_version_guard() RETURNS trigger
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
    IF NEW."status" = 'archived' THEN
      -- Withdrawing a scheduled version: only before it starts, and nothing else changes.
      IF OLD."validFrom" <= clock_timestamp() THEN
        RAISE EXCEPTION 'a published price version is frozen once it has started; it is never withdrawn' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW."label" IS DISTINCT FROM OLD."label" OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom" OR NEW."validTo" IS DISTINCT FROM OLD."validTo"
         OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" OR NEW."publishedById" IS DISTINCT FROM OLD."publishedById"
         OR NEW."version" IS DISTINCT FROM OLD."version" OR NEW."pricedTerms" IS DISTINCT FROM OLD."pricedTerms" THEN
        RAISE EXCEPTION 'a published price version is frozen; only its end is set, once' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."status" <> 'published' OR NEW."label" IS DISTINCT FROM OLD."label" OR NEW."validFrom" IS DISTINCT FROM OLD."validFrom"
       OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" OR NEW."publishedById" IS DISTINCT FROM OLD."publishedById" OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."pricedTerms" IS DISTINCT FROM OLD."pricedTerms" THEN
      RAISE EXCEPTION 'a published price version is frozen; only its end is set, once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."validTo" IS DISTINCT FROM OLD."validTo" THEN
      IF OLD."validTo" IS NOT NULL AND NEW."validTo" IS NULL THEN
        -- Reopening the end of a version when its scheduled successor is withdrawn: only an end still in the future.
        IF OLD."validTo" <= clock_timestamp() THEN
          RAISE EXCEPTION 'the end of a published price version is set once and not in the past' USING ERRCODE = 'insufficient_privilege';
        END IF;
      ELSIF OLD."validTo" IS NOT NULL OR NEW."validTo" IS NULL OR NEW."validTo" < now() - interval '1 millisecond' THEN
        RAISE EXCEPTION 'the end of a published price version is set once and not in the past' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an archived price version never changes' USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Withdrawing a scheduled version leaves no published version ending where it would have started: its predecessor
-- must have been reopened in the same transaction. Checked at commit.
CREATE FUNCTION public.mt_pricing_version_withdrawn() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF OLD."status" = 'published' AND NEW."status" = 'archived' AND EXISTS (
    SELECT 1 FROM "price_versions" p
    WHERE p."packageId" = NEW."packageId" AND p."status" = 'published' AND p."validTo" = OLD."validFrom"
  ) THEN
    RAISE EXCEPTION 'a withdrawn price version leaves its predecessor ending without a successor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER price_versions_withdrawn AFTER UPDATE ON "price_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_pricing_version_withdrawn();
