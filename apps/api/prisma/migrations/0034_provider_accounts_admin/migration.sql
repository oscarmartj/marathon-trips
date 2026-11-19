-- Task 4.1: gateway accounts managed from the admin panel (plan docs/plans/4.1-provider-accounts-panel.md).
-- Additive only. provider_accounts_test_mode_only_check (0017) stays: no live account can exist until a later
-- migration lifts it, gated on a verified adapter and Oscar's explicit approval (plan, section 14).

-- AlterTable
ALTER TABLE "provider_accounts" ADD COLUMN "credentialsChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "pauseReasonCode" TEXT,
ALTER COLUMN "webhookSecretCiphertext" DROP NOT NULL,
ALTER COLUMN "webhookKeyVersion" DROP NOT NULL;

-- Existing rows: their credentials last changed when they were created; a paused row was paused by staff.
UPDATE "provider_accounts" SET "credentialsChangedAt" = "createdAt";
UPDATE "provider_accounts" SET "pauseReasonCode" = 'staff' WHERE "status" = 'paused';

-- The webhook secret of an adapter whose secret the gateway issues (Stripe) is entered after creation (plan, 15.2).
ALTER TABLE "provider_accounts" DROP CONSTRAINT "provider_accounts_key_versions_check";
ALTER TABLE "provider_accounts"
  ADD CONSTRAINT "provider_accounts_key_versions_check" CHECK ("credentialsKeyVersion" >= 1 AND ("webhookKeyVersion" IS NULL OR "webhookKeyVersion" >= 1)),
  ADD CONSTRAINT "provider_accounts_webhook_secret_pair_check" CHECK (("webhookSecretCiphertext" IS NULL) = ("webhookKeyVersion" IS NULL)),
  -- A reason only on a paused account; the API always writes one (a paused row without one counts as paused by staff).
  ADD CONSTRAINT "provider_accounts_pause_reason_check" CHECK (
    "pauseReasonCode" IS NULL OR ("status" = 'paused' AND "pauseReasonCode" IN ('staff', 'boot_adapter_missing', 'boot_adapter_planned'))
  ),
  ADD CONSTRAINT "provider_accounts_connection_result_check" CHECK ("lastConnectionTestResult" IS NULL OR "lastConnectionTestResult" ~ '^[a-z_]{1,40}$');

-- The guard of 0017, extended: status pairs, credentials change time, and activation only after a current ok test.
CREATE OR REPLACE FUNCTION public.mt_provider_account_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  secrets_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a provider account is never deleted; retire or archive it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."mode" IS DISTINCT FROM OLD."mode" OR NEW."adapterKey" IS DISTINCT FROM OLD."adapterKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'the mode and adapter of a provider account never change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND (OLD."status"::text || '>' || NEW."status"::text) NOT IN
     ('active>paused', 'paused>active', 'active>retired', 'paused>retired', 'retired>archived') THEN
    RAISE EXCEPTION 'provider account status % cannot become %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  secrets_changed := NEW."credentialsCiphertext" IS DISTINCT FROM OLD."credentialsCiphertext"
    OR NEW."credentialsKeyVersion" IS DISTINCT FROM OLD."credentialsKeyVersion"
    OR NEW."webhookSecretCiphertext" IS DISTINCT FROM OLD."webhookSecretCiphertext"
    OR NEW."webhookKeyVersion" IS DISTINCT FROM OLD."webhookKeyVersion";
  IF secrets_changed AND NEW."credentialsChangedAt" <= OLD."credentialsChangedAt" THEN
    RAISE EXCEPTION 'a credentials change must move credentialsChangedAt forward' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT secrets_changed AND NEW."credentialsChangedAt" IS DISTINCT FROM OLD."credentialsChangedAt" THEN
    RAISE EXCEPTION 'credentialsChangedAt only moves with the credentials' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'paused' AND NEW."status" = 'active'
     AND (NEW."lastConnectionTestResult" IS DISTINCT FROM 'ok' OR NEW."lastConnectionTestAt" IS NULL OR NEW."lastConnectionTestAt" < NEW."credentialsChangedAt") THEN
    RAISE EXCEPTION 'an account is activated only after an ok connection test of its current credentials' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Accounts are never deleted or truncated by the API (the trigger already refuses; the privilege goes too).
REVOKE DELETE, TRUNCATE ON "provider_accounts" FROM mt_app;
