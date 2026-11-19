-- Task 4.2: payment routing rules and gateway health (plan docs/plans/4.2-routing-rules.md). Additive only.
-- provider_accounts_test_mode_only_check (0017) stays: rules point at accounts and never set a mode.

-- CreateTable
CREATE TABLE "payment_routing_rules" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "countries" TEXT[],
    "anyCountry" BOOLEAN NOT NULL DEFAULT true,
    "currency" CHAR(3) NOT NULL,
    "minAmountMinor" BIGINT,
    "maxAmountMinor" BIGINT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fallbackForRuleId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_account_health" (
    "providerAccountId" UUID NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMPTZ(3),
    "lastFailureCode" TEXT,
    "openedAt" TIMESTAMPTZ(3),
    "openUntil" TIMESTAMPTZ(3),
    "probeUntil" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_account_health_pkey" PRIMARY KEY ("providerAccountId")
);

-- CreateIndex
CREATE INDEX "payment_routing_rules_currency_method_enabled_idx" ON "payment_routing_rules"("currency", "method", "enabled");

-- CreateIndex
CREATE INDEX "payment_routing_rules_providerAccountId_idx" ON "payment_routing_rules"("providerAccountId");

-- CreateIndex
CREATE INDEX "payment_routing_rules_fallbackForRuleId_idx" ON "payment_routing_rules"("fallbackForRuleId");

-- AddForeignKey
ALTER TABLE "payment_routing_rules" ADD CONSTRAINT "payment_routing_rules_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "payment_routing_rules" ADD CONSTRAINT "payment_routing_rules_fallbackForRuleId_fkey" FOREIGN KEY ("fallbackForRuleId") REFERENCES "payment_routing_rules"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "provider_account_health" ADD CONSTRAINT "provider_account_health_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Every code is upper-case ISO 3166 alpha-2 and appears once.
CREATE FUNCTION public.mt_country_codes_valid(codes text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT coalesce(bool_and(c ~ '^[A-Z]{2}$'), true) AND count(*) = count(DISTINCT c) FROM unnest(codes) AS c
$$;

ALTER TABLE "payment_routing_rules"
  ADD CONSTRAINT "payment_routing_rules_countries_check" CHECK (
    "countries" IS NOT NULL AND public.mt_country_codes_valid("countries") AND "anyCountry" = (cardinality("countries") = 0)
  ),
  ADD CONSTRAINT "payment_routing_rules_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "payment_routing_rules_min_check" CHECK ("minAmountMinor" IS NULL OR ("minAmountMinor" >= 0 AND "minAmountMinor" <= 1000000000000)),
  ADD CONSTRAINT "payment_routing_rules_max_check" CHECK ("maxAmountMinor" IS NULL OR ("maxAmountMinor" > 0 AND "maxAmountMinor" <= 1000000000000)),
  ADD CONSTRAINT "payment_routing_rules_limits_check" CHECK ("minAmountMinor" IS NULL OR "maxAmountMinor" IS NULL OR "minAmountMinor" <= "maxAmountMinor"),
  ADD CONSTRAINT "payment_routing_rules_priority_check" CHECK ("priority" BETWEEN 0 AND 1000),
  ADD CONSTRAINT "payment_routing_rules_version_check" CHECK ("version" >= 0),
  ADD CONSTRAINT "payment_routing_rules_fallback_self_check" CHECK ("fallbackForRuleId" IS NULL OR "fallbackForRuleId" <> "id");

ALTER TABLE "provider_account_health"
  ADD CONSTRAINT "provider_account_health_failures_check" CHECK ("consecutiveFailures" >= 0),
  ADD CONSTRAINT "provider_account_health_code_check" CHECK (
    "lastFailureCode" IS NULL OR "lastFailureCode" IN ('provider_unavailable', 'provider_timeout', 'provider_auth_failed')
  );

-- The net behind the service checks (plan, sections 1.1 and 15.8): one level of backups, same method and currency,
-- another account; a rule's account never changes. The rows involved are locked, so two transactions cannot build a chain.
CREATE FUNCTION public.mt_routing_rule_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" THEN
    RAISE EXCEPTION 'the account of a routing rule never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fallbackForRuleId" IS NOT NULL THEN
    SELECT "id", "method", "currency", "providerAccountId", "fallbackForRuleId" INTO target
      FROM "payment_routing_rules" WHERE "id" = NEW."fallbackForRuleId" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the rule a backup is for does not exist' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF target."fallbackForRuleId" IS NOT NULL THEN
      RAISE EXCEPTION 'a backup cannot back up another backup' USING ERRCODE = 'check_violation';
    END IF;
    IF target."method" <> NEW."method" OR target."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'a backup has the method and currency of its rule' USING ERRCODE = 'check_violation';
    END IF;
    IF target."providerAccountId" = NEW."providerAccountId" THEN
      RAISE EXCEPTION 'a backup sends payments to another account' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM 1 FROM "payment_routing_rules" WHERE "fallbackForRuleId" = NEW."id" FOR UPDATE;
    IF FOUND AND (NEW."fallbackForRuleId" IS NOT NULL OR NEW."method" <> OLD."method" OR NEW."currency" <> OLD."currency") THEN
      RAISE EXCEPTION 'a rule with backups keeps its method and currency and cannot become a backup' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mt_routing_rule_guard BEFORE INSERT OR UPDATE ON "payment_routing_rules"
  FOR EACH ROW EXECUTE FUNCTION public.mt_routing_rule_guard();

-- Health rows are kept (no DELETE by the API).
REVOKE DELETE, TRUNCATE ON "provider_account_health" FROM mt_app;
REVOKE TRUNCATE ON "payment_routing_rules" FROM mt_app;

-- Backfill (plan, sections 1.3 and 15.7): the default rules of each adapter as its manifest stands in this migration,
-- for every account that can take charges, with the account's createdAt so the order of task 3.1 is kept.
-- @backfill simulator: card, apple_pay, google_pay
-- @backfill stripe: card, apple_pay, google_pay
-- @backfill manual: payid_transfer, manual_other
INSERT INTO "payment_routing_rules" ("id", "providerAccountId", "method", "countries", "anyCountry", "currency", "priority", "enabled", "createdAt", "updatedAt")
SELECT gen_random_uuid(), a."id", m.method::"PaymentMethod", ARRAY[]::text[], true, 'AUD', 100, true, a."createdAt", CURRENT_TIMESTAMP
FROM "provider_accounts" a
JOIN (VALUES
  ('simulator', 'card'), ('simulator', 'apple_pay'), ('simulator', 'google_pay'),
  ('stripe', 'card'), ('stripe', 'apple_pay'), ('stripe', 'google_pay'),
  ('manual', 'payid_transfer'), ('manual', 'manual_other')
) AS m(adapter, method) ON m.adapter = a."adapterKey"
WHERE a."status" IN ('active', 'paused');
