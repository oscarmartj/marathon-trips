-- Task 4.4: card sessions of gateways whose card is typed into their hosted fields on our page (Pin Payments), the
-- charges seen under them and refund intents (plan docs/plans/4.4-au-card-gateway.md, sections 6, 7, 11 and 18).
-- Additive only. provider_accounts_test_mode_only_check (0017) stays. No email, IP or card data in these tables.

-- CreateTable
CREATE TABLE "card_sessions" (
    "id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "paymentId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "chargeRef" TEXT,
    "chargedMinor" BIGINT,
    "failureCode" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "verifyCalls" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "card_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_session_charges" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "chargeRef" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "seenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_session_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_refund_intents" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "refundId" UUID NOT NULL,
    "chargeRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "refundRef" TEXT,
    "lastAnswer" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "card_refund_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "card_sessions_ref_key" ON "card_sessions"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "card_sessions_providerAccountId_idempotencyKey_key" ON "card_sessions"("providerAccountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "card_sessions_providerAccountId_chargeRef_key" ON "card_sessions"("providerAccountId", "chargeRef");

-- CreateIndex
CREATE UNIQUE INDEX "card_session_charges_chargeRef_key" ON "card_session_charges"("chargeRef");

-- CreateIndex
CREATE INDEX "card_session_charges_sessionId_idx" ON "card_session_charges"("sessionId");

-- CreateIndex
CREATE INDEX "card_refund_intents_providerAccountId_chargeRef_idx" ON "card_refund_intents"("providerAccountId", "chargeRef");

-- CreateIndex
CREATE UNIQUE INDEX "card_refund_intents_providerAccountId_idempotencyKey_key" ON "card_refund_intents"("providerAccountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "card_refund_intents_providerAccountId_refundRef_key" ON "card_refund_intents"("providerAccountId", "refundRef");

-- AddForeignKey
ALTER TABLE "card_sessions" ADD CONSTRAINT "card_sessions_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "card_refund_intents" ADD CONSTRAINT "card_refund_intents_providerAccountId_fkey" FOREIGN KEY ("providerAccountId") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Shapes and closed lists.
ALTER TABLE "card_sessions"
  ADD CONSTRAINT "card_sessions_ref_check" CHECK ("ref" ~ '^cs_[0-9a-f]{32}$'),
  ADD CONSTRAINT "card_sessions_key_check" CHECK (length("idempotencyKey") BETWEEN 1 AND 200),
  ADD CONSTRAINT "card_sessions_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "card_sessions_amount_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 999999999),
  ADD CONSTRAINT "card_sessions_charged_check" CHECK ("chargedMinor" IS NULL OR ("chargedMinor" >= 0 AND "chargedMinor" <= 999999999)),
  ADD CONSTRAINT "card_sessions_return_url_check" CHECK ("returnUrl" ~ '^https?://' AND length("returnUrl") <= 2048),
  ADD CONSTRAINT "card_sessions_status_check" CHECK ("status" IN ('open', 'submitting', 'authenticating', 'succeeded', 'failed', 'cancelled')),
  ADD CONSTRAINT "card_sessions_charge_ref_check" CHECK ("chargeRef" IS NULL OR "chargeRef" ~ '^ch_[A-Za-z0-9_-]{10,40}$'),
  ADD CONSTRAINT "card_sessions_failure_code_check" CHECK ("failureCode" IS NULL OR "failureCode" IN (
    'card_declined', 'insufficient_funds', 'expired_card', 'card_not_authenticated', 'processing_error', 'suspected_fraud',
    'provider_rejected', 'provider_auth_failed', 'provider_busy', 'outcome_unknown', 'expired', 'too_many_attempts')),
  ADD CONSTRAINT "card_sessions_verify_calls_check" CHECK ("verifyCalls" BETWEEN 0 AND 3),
  ADD CONSTRAINT "card_sessions_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "card_sessions_submitted_check" CHECK (("status" = 'open') = ("submittedAt" IS NULL) OR ("status" = 'cancelled' AND "submittedAt" IS NULL)),
  ADD CONSTRAINT "card_sessions_succeeded_check" CHECK ("status" <> 'succeeded' OR ("chargeRef" IS NOT NULL AND "chargedMinor" IS NOT NULL));

ALTER TABLE "card_session_charges"
  ADD CONSTRAINT "card_session_charges_ref_check" CHECK ("chargeRef" ~ '^ch_[A-Za-z0-9_-]{10,40}$'),
  ADD CONSTRAINT "card_session_charges_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "card_session_charges_amount_check" CHECK ("amountMinor" >= 0 AND "amountMinor" <= 999999999);

ALTER TABLE "card_refund_intents"
  ADD CONSTRAINT "card_refund_intents_key_check" CHECK (length("idempotencyKey") BETWEEN 1 AND 200),
  ADD CONSTRAINT "card_refund_intents_charge_ref_check" CHECK ("chargeRef" ~ '^ch_[A-Za-z0-9_-]{10,40}$'),
  ADD CONSTRAINT "card_refund_intents_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "card_refund_intents_amount_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 999999999),
  ADD CONSTRAINT "card_refund_intents_status_check" CHECK ("status" IN ('new', 'submitting', 'bound', 'refused')),
  ADD CONSTRAINT "card_refund_intents_ref_check" CHECK ("refundRef" IS NULL OR "refundRef" ~ '^rf_[A-Za-z0-9_-]{10,40}$'),
  ADD CONSTRAINT "card_refund_intents_bound_check" CHECK (("status" = 'bound') = ("refundRef" IS NOT NULL)),
  ADD CONSTRAINT "card_refund_intents_last_answer_check" CHECK ("lastAnswer" IS NULL OR "lastAnswer" IN ('rate_limited', 'auth_failed')),
  ADD CONSTRAINT "card_refund_intents_version_check" CHECK ("version" >= 1);

-- The transitions of a session (plan 4.4, sections 6.5 and 18 M2): forward only, never back to open; submittedAt,
-- chargeRef, the amount and the links are set once; failed -> succeeded only for an unknown outcome without a charge.
CREATE FUNCTION public.mt_card_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_mode "PaymentMode";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'card sessions are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT mode INTO account_mode FROM provider_accounts WHERE id = NEW."providerAccountId";
    IF account_mode IS DISTINCT FROM NEW.mode THEN
      RAISE EXCEPTION 'card_session_mode_mismatch' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> 'open' OR NEW."chargeRef" IS NOT NULL OR NEW."submittedAt" IS NOT NULL OR NEW."verifyCalls" <> 0 OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'card_session_insert_not_open' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.ref <> OLD.ref OR NEW."providerAccountId" <> OLD."providerAccountId" OR NEW.mode <> OLD.mode
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
  IF NEW."verifyCalls" <> OLD."verifyCalls" AND NEW."verifyCalls" <> OLD."verifyCalls" + 1 THEN
    RAISE EXCEPTION 'card_session_verify_calls' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW."failureCode" IS DISTINCT FROM OLD."failureCode" OR NEW."chargedMinor" IS DISTINCT FROM OLD."chargedMinor" THEN
      RAISE EXCEPTION 'card_session_failure_code_fixed' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (
       (OLD.status = 'open' AND NEW.status IN ('submitting', 'cancelled'))
    OR (OLD.status = 'submitting' AND NEW.status IN ('authenticating', 'succeeded', 'failed'))
    OR (OLD.status = 'authenticating' AND NEW.status IN ('succeeded', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'succeeded' AND OLD."failureCode" IN ('outcome_unknown', 'provider_busy') AND OLD."chargeRef" IS NULL)
  ) THEN
    RAISE EXCEPTION 'card_session_transition' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'submitting' AND NEW."submittedAt" IS NULL THEN
    RAISE EXCEPTION 'card_session_submitted_at_required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER card_sessions_guard BEFORE INSERT OR UPDATE OR DELETE ON "card_sessions"
  FOR EACH ROW EXECUTE FUNCTION public.mt_card_session_guard();
CREATE TRIGGER card_sessions_no_truncate BEFORE TRUNCATE ON "card_sessions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Refund intents: new -> submitting -> bound | refused; back to new only when the gateway processed nothing.
CREATE FUNCTION public.mt_card_refund_intent_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  account_mode "PaymentMode";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'card refund intents are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT mode INTO account_mode FROM provider_accounts WHERE id = NEW."providerAccountId";
    IF account_mode IS DISTINCT FROM NEW.mode THEN
      RAISE EXCEPTION 'card_refund_intent_mode_mismatch' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> 'new' OR NEW."refundRef" IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'card_refund_intent_insert_not_new' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW."providerAccountId" <> OLD."providerAccountId" OR NEW.mode <> OLD.mode OR NEW."idempotencyKey" <> OLD."idempotencyKey"
     OR NEW."refundId" <> OLD."refundId" OR NEW."chargeRef" <> OLD."chargeRef" OR NEW."amountMinor" <> OLD."amountMinor"
     OR NEW.currency <> OLD.currency OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'card_refund_intent_fixed_column' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'card_refund_intent_version' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."refundRef" IS NOT NULL AND NEW."refundRef" IS DISTINCT FROM OLD."refundRef" THEN
    RAISE EXCEPTION 'card_refund_intent_ref_fixed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
       (OLD.status = 'new' AND NEW.status = 'submitting')
    OR (OLD.status = 'submitting' AND NEW.status IN ('bound', 'refused'))
    OR (OLD.status = 'submitting' AND NEW.status = 'new' AND NEW."lastAnswer" IN ('rate_limited', 'auth_failed'))
  ) THEN
    RAISE EXCEPTION 'card_refund_intent_transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER card_refund_intents_guard BEFORE INSERT OR UPDATE OR DELETE ON "card_refund_intents"
  FOR EACH ROW EXECUTE FUNCTION public.mt_card_refund_intent_guard();
CREATE TRIGGER card_refund_intents_no_truncate BEFORE TRUNCATE ON "card_refund_intents"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Charges seen under a session: append-only.
CREATE TRIGGER card_session_charges_append_only BEFORE UPDATE OR DELETE ON "card_session_charges"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER card_session_charges_no_truncate BEFORE TRUNCATE ON "card_session_charges"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- The API's role: no DELETE anywhere here, no UPDATE on the append-only table.
REVOKE DELETE, TRUNCATE ON "card_sessions", "card_refund_intents" FROM mt_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "card_session_charges" FROM mt_app;
