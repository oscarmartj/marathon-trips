-- Task 9.1: card sessions whose 3-D Secure comes before the one charge (eWAY), next to Pin's flow (plan
-- docs/plans/9.1-eway.md, sections 4.1, 4.3, 11 and 20 M2, m8). Adds two columns and a fixed `flow`; widens the reference
-- shapes to each flow's own; replaces the session guard keeping every rule of 0039. 0039 is not edited.
-- provider_accounts_test_mode_only_check (0017) stays. No card data, email, phone or IP in these tables.

ALTER TABLE "card_sessions"
  ADD COLUMN "flow" TEXT NOT NULL DEFAULT 'after_charge',
  ADD COLUMN "authRef" TEXT,
  ADD COLUMN "authCardHash" TEXT;

-- Each flow its own reference shapes (m8): Pin's ch_ under after_charge, eWAY's ewt_ under before_charge.
ALTER TABLE "card_sessions"
  DROP CONSTRAINT "card_sessions_charge_ref_check",
  DROP CONSTRAINT "card_sessions_submitted_check",
  ADD CONSTRAINT "card_sessions_flow_check" CHECK ("flow" IN ('after_charge', 'before_charge')),
  ADD CONSTRAINT "card_sessions_charge_ref_check" CHECK ("chargeRef" IS NULL
    OR ("flow" = 'after_charge' AND "chargeRef" ~ '^ch_[A-Za-z0-9_-]{10,40}$')
    OR ("flow" = 'before_charge' AND "chargeRef" ~ '^ewt_[0-9]{1,19}$')),
  ADD CONSTRAINT "card_sessions_auth_ref_check" CHECK ("authRef" IS NULL OR ("flow" = 'before_charge' AND "authRef" ~ '^[A-Za-z0-9_-]+$' AND length("authRef") BETWEEN 10 AND 512)),
  ADD CONSTRAINT "card_sessions_auth_card_check" CHECK ("authCardHash" IS NULL OR ("flow" = 'before_charge' AND "authCardHash" ~ '^[0-9a-f]{64}$')),
  -- 0039's rule (submittedAt exactly when no longer open, cancelled while unsent) plus, for before_charge only (M2):
  -- authenticating before the charge is sent, cancelled or failed before it, never succeeded without it.
  ADD CONSTRAINT "card_sessions_submitted_check" CHECK (
       ("status" = 'open' AND "submittedAt" IS NULL)
    OR "status" = 'cancelled'
    OR ("status" IN ('submitting', 'succeeded') AND "submittedAt" IS NOT NULL)
    OR ("status" IN ('authenticating', 'failed') AND "submittedAt" IS NOT NULL)
    OR ("flow" = 'before_charge' AND "status" = 'authenticating' AND "submittedAt" IS NULL AND "authCardHash" IS NOT NULL AND "chargeRef" IS NULL)
    OR ("flow" = 'before_charge' AND "status" = 'failed' AND "submittedAt" IS NULL AND "authCardHash" IS NOT NULL AND "chargeRef" IS NULL
        AND "failureCode" IN ('card_not_authenticated', 'card_declined', 'insufficient_funds', 'expired_card', 'processing_error', 'suspected_fraud', 'provider_rejected', 'provider_auth_failed', 'too_many_attempts')));

ALTER TABLE "card_session_charges"
  DROP CONSTRAINT "card_session_charges_ref_check",
  ADD CONSTRAINT "card_session_charges_ref_check" CHECK ("chargeRef" ~ '^ch_[A-Za-z0-9_-]{10,40}$' OR "chargeRef" ~ '^ewt_[0-9]{1,19}$');

ALTER TABLE "card_refund_intents"
  DROP CONSTRAINT "card_refund_intents_charge_ref_check",
  DROP CONSTRAINT "card_refund_intents_ref_check",
  ADD CONSTRAINT "card_refund_intents_charge_ref_check" CHECK ("chargeRef" ~ '^ch_[A-Za-z0-9_-]{10,40}$' OR "chargeRef" ~ '^ewt_[0-9]{1,19}$'),
  ADD CONSTRAINT "card_refund_intents_ref_check" CHECK ("refundRef" IS NULL OR "refundRef" ~ '^rf_[A-Za-z0-9_-]{10,40}$' OR "refundRef" ~ '^ewr_[0-9]{1,19}$');

-- The session guard of 0039, with the flow (m8): fixed at insert from the account's adapter (as mode is), and each
-- flow's own edges (M2). Every 0039 rule is kept.
CREATE OR REPLACE FUNCTION public.mt_card_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_mode "PaymentMode";
  account_adapter TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'card sessions are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT mode, "adapterKey" INTO account_mode, account_adapter FROM provider_accounts WHERE id = NEW."providerAccountId";
    IF account_mode IS DISTINCT FROM NEW.mode THEN
      RAISE EXCEPTION 'card_session_mode_mismatch' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.flow IS DISTINCT FROM (CASE WHEN account_adapter = 'eway' THEN 'before_charge' ELSE 'after_charge' END) THEN
      RAISE EXCEPTION 'card_session_flow_mismatch' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> 'open' OR NEW."chargeRef" IS NOT NULL OR NEW."submittedAt" IS NOT NULL OR NEW."verifyCalls" <> 0 OR NEW.version <> 1
       OR NEW."authRef" IS NOT NULL OR NEW."authCardHash" IS NOT NULL THEN
      RAISE EXCEPTION 'card_session_insert_not_open' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.ref <> OLD.ref OR NEW."providerAccountId" <> OLD."providerAccountId" OR NEW.mode <> OLD.mode OR NEW.flow <> OLD.flow
     OR NEW."idempotencyKey" <> OLD."idempotencyKey" OR NEW."paymentId" <> OLD."paymentId" OR NEW."bookingId" <> OLD."bookingId"
     OR NEW.currency <> OLD.currency OR NEW."amountMinor" <> OLD."amountMinor" OR NEW."returnUrl" <> OLD."returnUrl"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'card_session_fixed_column' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'card_session_version' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION 'card_session_submitted_once' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."chargeRef" IS NOT NULL AND NEW."chargeRef" IS DISTINCT FROM OLD."chargeRef" THEN
    RAISE EXCEPTION 'card_session_charge_fixed' USING ERRCODE = 'P0001';
  END IF;
  IF (OLD."authRef" IS NOT NULL AND NEW."authRef" IS DISTINCT FROM OLD."authRef")
     OR (OLD."authCardHash" IS NOT NULL AND NEW."authCardHash" IS DISTINCT FROM OLD."authCardHash") THEN
    RAISE EXCEPTION 'card_session_auth_fixed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."verifyCalls" <> OLD."verifyCalls" AND NEW."verifyCalls" <> OLD."verifyCalls" + 1 THEN
    RAISE EXCEPTION 'card_session_verify_calls' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW."failureCode" IS DISTINCT FROM OLD."failureCode" OR NEW."chargedMinor" IS DISTINCT FROM OLD."chargedMinor" THEN
      RAISE EXCEPTION 'card_session_failure_code_fixed' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.flow = 'after_charge' AND NOT (
       (OLD.status = 'open' AND NEW.status IN ('submitting', 'cancelled'))
    OR (OLD.status = 'submitting' AND NEW.status IN ('authenticating', 'succeeded', 'failed'))
    OR (OLD.status = 'authenticating' AND NEW.status IN ('succeeded', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'succeeded' AND OLD."failureCode" IN ('outcome_unknown', 'provider_busy') AND OLD."chargeRef" IS NULL)
  ) THEN
    RAISE EXCEPTION 'card_session_transition' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.flow = 'before_charge' AND NOT (
       (OLD.status = 'open' AND NEW.status = 'authenticating' AND NEW."authCardHash" IS NOT NULL AND NEW."submittedAt" IS NULL)
    OR (OLD.status = 'open' AND NEW.status = 'cancelled')
    OR (OLD.status = 'authenticating' AND OLD."submittedAt" IS NULL AND OLD."chargeRef" IS NULL AND NEW.status = 'submitting' AND NEW."authRef" IS NOT NULL)
    OR (OLD.status = 'authenticating' AND OLD."submittedAt" IS NULL AND NEW.status = 'cancelled')
    OR (OLD.status = 'authenticating' AND OLD."submittedAt" IS NULL AND NEW.status = 'failed' AND NEW."chargeRef" IS NULL
        AND NEW."failureCode" IN ('card_not_authenticated', 'card_declined', 'insufficient_funds', 'expired_card', 'processing_error', 'suspected_fraud', 'provider_rejected', 'provider_auth_failed', 'too_many_attempts'))
    OR (OLD.status = 'submitting' AND NEW.status IN ('succeeded', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'succeeded' AND OLD."failureCode" IN ('outcome_unknown', 'provider_busy') AND OLD."chargeRef" IS NULL AND OLD."submittedAt" IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'card_session_transition' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'submitting' AND NEW."submittedAt" IS NULL THEN
    RAISE EXCEPTION 'card_session_submitted_at_required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

-- Charges and refund intents take the reference shape of their account's adapter (m8). Two functions: a row of one
-- table has no column of the other.
CREATE FUNCTION public.mt_card_charge_shape_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_adapter TEXT;
BEGIN
  SELECT "adapterKey" INTO account_adapter FROM provider_accounts WHERE id = NEW."providerAccountId";
  IF (NEW."chargeRef" ~ '^ewt_') IS DISTINCT FROM (account_adapter = 'eway') THEN
    RAISE EXCEPTION 'card_ref_shape_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION public.mt_card_refund_shape_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_adapter TEXT;
BEGIN
  SELECT "adapterKey" INTO account_adapter FROM provider_accounts WHERE id = NEW."providerAccountId";
  IF (NEW."chargeRef" ~ '^ewt_') IS DISTINCT FROM (account_adapter = 'eway') THEN
    RAISE EXCEPTION 'card_ref_shape_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."refundRef" IS NOT NULL AND (NEW."refundRef" ~ '^ewr_') IS DISTINCT FROM (account_adapter = 'eway') THEN
    RAISE EXCEPTION 'card_ref_shape_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER card_session_charges_ref_shape BEFORE INSERT ON "card_session_charges"
  FOR EACH ROW EXECUTE FUNCTION public.mt_card_charge_shape_guard();
CREATE TRIGGER card_refund_intents_ref_shape BEFORE INSERT OR UPDATE ON "card_refund_intents"
  FOR EACH ROW EXECUTE FUNCTION public.mt_card_refund_shape_guard();
