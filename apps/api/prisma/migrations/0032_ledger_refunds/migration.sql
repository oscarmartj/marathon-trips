-- Task 3.3: the payment ledger, refunds made on a gateway's dashboard, and the queue of the daily ledger check (plan
-- docs/plans/3.3-stripe-adapter-ledger.md, sections 1, 3, 4 and 12). Additive only: undoing it is a new migration.
-- Provider accounts keep CHECK (mode = 'test').

-- CreateEnum
CREATE TYPE "RefundOrigin" AS ENUM ('app', 'external');

-- CreateEnum
CREATE TYPE "RefundPurpose" AS ENUM ('price_reduction', 'overpayment_return', 'cancellation');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('requested', 'pending', 'succeeded', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "LedgerAccountKind" AS ENUM ('asset', 'liability', 'revenue', 'expense');

-- CreateEnum
CREATE TYPE "LedgerTransactionKind" AS ENUM ('payment', 'refund', 'fee', 'chargeback', 'supplier_payment', 'adjustment', 'reversal');

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN "refundId" UUID;

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "origin" "RefundOrigin" NOT NULL,
    "purpose" "RefundPurpose",
    "reason" TEXT,
    "status" "RefundStatus" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerRefundRef" TEXT,
    "failureCode" TEXT,
    "requestedById" UUID,
    "succeededAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "LedgerAccountKind" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "LedgerTransactionKind" NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "bookingId" UUID,
    "paymentId" UUID,
    "refundId" UUID,
    "reversesTransactionId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "contentSha256" CHAR(64) NOT NULL,
    "createdTxId" BIGINT,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "accountCode" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "bookingId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_refundId_idx" ON "webhook_events"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotencyKey_key" ON "refunds"("idempotencyKey");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "refunds_bookingId_idx" ON "refunds"("bookingId");

-- CreateIndex
CREATE INDEX "refunds_status_updatedAt_idx" ON "refunds"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_id_mode_key" ON "refunds"("id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_providerAccountId_providerRefundRef_key" ON "refunds"("providerAccountId", "providerRefundRef");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_currency_mode_key" ON "ledger_accounts"("code", "currency", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotencyKey_key" ON "ledger_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ledger_transactions_bookingId_idx" ON "ledger_transactions"("bookingId");

-- CreateIndex
CREATE INDEX "ledger_transactions_paymentId_idx" ON "ledger_transactions"("paymentId");

-- CreateIndex
CREATE INDEX "ledger_transactions_refundId_idx" ON "ledger_transactions"("refundId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_id_mode_key" ON "ledger_transactions"("id", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_reversesTransactionId_key" ON "ledger_transactions"("reversesTransactionId");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- CreateIndex
CREATE INDEX "ledger_entries_bookingId_accountCode_idx" ON "ledger_entries"("bookingId", "accountCode");

-- CreateIndex
CREATE INDEX "ledger_entries_accountCode_currency_mode_idx" ON "ledger_entries"("accountCode", "currency", "mode");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_fkey" FOREIGN KEY ("paymentId", "bookingId", "providerAccountId", "mode", "currency") REFERENCES "payments"("id", "bookingId", "providerAccountId", "mode", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_paymentId_mode_fkey" FOREIGN KEY ("paymentId", "mode") REFERENCES "payments"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_refundId_mode_fkey" FOREIGN KEY ("refundId", "mode") REFERENCES "refunds"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reversesTransactionId_mode_fkey" FOREIGN KEY ("reversesTransactionId", "mode") REFERENCES "ledger_transactions"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_mode_fkey" FOREIGN KEY ("transactionId", "mode") REFERENCES "ledger_transactions"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_accountCode_currency_mode_fkey" FOREIGN KEY ("accountCode", "currency", "mode") REFERENCES "ledger_accounts"("code", "currency", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---- Refunds (plan 3.3, section 3.1): status forward only, identity fixed, never deleted ----
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "refunds_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- Refunds started from the app come with task 4.5 (purposes P9, caps P10); until then only gateway-dashboard ones.
  ADD CONSTRAINT "refunds_origin_check" CHECK ("origin" = 'external'),
  ADD CONSTRAINT "refunds_purpose_check" CHECK ("origin" = 'external' OR "purpose" IS NOT NULL),
  ADD CONSTRAINT "refunds_reference_check" CHECK (("status" NOT IN ('succeeded', 'reversed') AND "origin" <> 'external') OR "providerRefundRef" IS NOT NULL),
  ADD CONSTRAINT "refunds_succeeded_check" CHECK (("status" IN ('succeeded', 'reversed')) = ("succeededAt" IS NOT NULL)),
  ADD CONSTRAINT "refunds_codes_check" CHECK (("failureCode" IS NULL OR "failureCode" ~ '^[a-z0-9_]{1,64}$') AND char_length("idempotencyKey") <= 200 AND ("providerRefundRef" IS NULL OR char_length("providerRefundRef") <= 255));
CREATE FUNCTION public.mt_refund_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a refund is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'reversed' THEN
      RAISE EXCEPTION 'a refund cannot start reversed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."origin" IS DISTINCT FROM OLD."origin" OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR (OLD."providerRefundRef" IS NOT NULL AND NEW."providerRefundRef" IS DISTINCT FROM OLD."providerRefundRef")
     OR (OLD."succeededAt" IS NOT NULL AND NEW."succeededAt" IS DISTINCT FROM OLD."succeededAt") THEN
    RAISE EXCEPTION 'the identity of a refund never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The reason is personal data: erasure may only empty it.
  IF NEW."reason" IS DISTINCT FROM OLD."reason" AND NEW."reason" IS NOT NULL THEN
    RAISE EXCEPTION 'a refund reason is never rewritten' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT ((OLD."status", NEW."status") IN (
      ('requested'::"RefundStatus", 'pending'::"RefundStatus"), ('requested', 'succeeded'), ('requested', 'failed'),
      ('pending', 'succeeded'), ('pending', 'failed'),
      ('succeeded', 'reversed')
    )) THEN
      RAISE EXCEPTION 'refund status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'a change of refund status bumps its version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER refunds_guard BEFORE INSERT OR UPDATE OR DELETE ON "refunds"
  FOR EACH ROW EXECUTE FUNCTION public.mt_refund_guard();
CREATE TRIGGER refunds_no_truncate BEFORE TRUNCATE ON "refunds"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Webhook events: the refund link is set once, like the payment link (replaces the 0017 guard) ----
CREATE OR REPLACE FUNCTION public.mt_webhook_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a webhook event is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
     OR NEW."providerEventId" IS DISTINCT FROM OLD."providerEventId" OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."headers" IS DISTINCT FROM OLD."headers" OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
     OR (NEW."rawBody" IS DISTINCT FROM OLD."rawBody" AND NEW."rawBody" IS NOT NULL)
     OR (OLD."bookingId" IS NOT NULL AND NEW."bookingId" IS DISTINCT FROM OLD."bookingId")
     OR (OLD."paymentId" IS NOT NULL AND NEW."paymentId" IS DISTINCT FROM OLD."paymentId")
     OR (OLD."refundId" IS NOT NULL AND NEW."refundId" IS DISTINCT FROM OLD."refundId") THEN
    RAISE EXCEPTION 'a webhook event is never edited, only matched and processed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Ledger (plan 3.3, section 1): append-only, balanced per currency at commit ----
ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_code_check" CHECK ("code" ~ '^[a-z_]{1,60}(:[0-9a-f-]{36})?$'),
  ADD CONSTRAINT "ledger_accounts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
CREATE TRIGGER ledger_accounts_append_only BEFORE UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON "ledger_accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_payment_check" CHECK ("kind" <> 'payment' OR "paymentId" IS NOT NULL),
  ADD CONSTRAINT "ledger_transactions_refund_check" CHECK ("kind" <> 'refund' OR "refundId" IS NOT NULL),
  ADD CONSTRAINT "ledger_transactions_reversal_check" CHECK (("kind" = 'reversal') = ("reversesTransactionId" IS NOT NULL)),
  ADD CONSTRAINT "ledger_transactions_booking_check" CHECK (("paymentId" IS NULL AND "refundId" IS NULL) OR "bookingId" IS NOT NULL),
  ADD CONSTRAINT "ledger_transactions_text_check" CHECK ("description" ~ '^[a-z0-9_.:-]{1,120}$' AND char_length("idempotencyKey") BETWEEN 1 AND 200 AND "contentSha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "ledger_transactions_created_tx_check" CHECK ("createdTxId" IS NOT NULL);
-- Sets the creating database transaction, and checks the booking is the payment's and the refund's (plan 0.1, P11).
CREATE FUNCTION public.mt_ledger_transaction_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW."createdTxId" := pg_current_xact_id()::text::bigint;
  IF NEW."paymentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = NEW."paymentId" AND p."bookingId" = NEW."bookingId") THEN
    RAISE EXCEPTION 'a ledger transaction belongs to the booking of its payment' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."refundId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.id = NEW."refundId" AND r."bookingId" = NEW."bookingId") THEN
    RAISE EXCEPTION 'a ledger transaction belongs to the booking of its refund' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversesTransactionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_transactions o WHERE o.id = NEW."reversesTransactionId" AND o."bookingId" IS NOT DISTINCT FROM NEW."bookingId") THEN
    RAISE EXCEPTION 'a reversal belongs to the booking of what it reverses' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_transactions_insert BEFORE INSERT ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION public.mt_ledger_transaction_insert();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON "ledger_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_check" CHECK ("amountMinor" <> 0),
  ADD CONSTRAINT "ledger_entries_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
-- An entry joins a transaction only in the database transaction that created it (plan review, point 2), carries its
-- booking, and a payment's entries are in the payment's currency (plan 0.1, P8).
CREATE FUNCTION public.mt_ledger_entry_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  parent record;
BEGIN
  SELECT t."createdTxId", t."bookingId", t."paymentId" INTO parent FROM ledger_transactions t WHERE t.id = NEW."transactionId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a ledger entry needs its transaction' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent."createdTxId" IS DISTINCT FROM pg_current_xact_id()::text::bigint THEN
    RAISE EXCEPTION 'entries cannot be added to a committed ledger transaction' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."bookingId" IS DISTINCT FROM parent."bookingId" THEN
    RAISE EXCEPTION 'a ledger entry carries the booking of its transaction' USING ERRCODE = 'check_violation';
  END IF;
  IF parent."paymentId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = parent."paymentId" AND p.currency = NEW."currency") THEN
    RAISE EXCEPTION 'the entries of a payment are in its currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_entries_insert BEFORE INSERT ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION public.mt_ledger_entry_insert();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- At commit: every transaction has at least two entries and sums to 0 in each currency.
CREATE FUNCTION public.mt_ledger_transaction_balanced() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  tx_id uuid;
  n integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    tx_id := NEW.id;
  ELSE
    tx_id := NEW."transactionId";
  END IF;
  SELECT count(*) INTO n FROM ledger_entries WHERE "transactionId" = tx_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'a ledger transaction needs at least two entries' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM ledger_entries WHERE "transactionId" = tx_id GROUP BY currency HAVING sum("amountMinor") <> 0) THEN
    RAISE EXCEPTION 'a ledger transaction must balance in each currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_ledger_transaction_balanced();
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_ledger_transaction_balanced();

-- The API role adds to the ledger and never changes it (two layers with the triggers).
REVOKE UPDATE, DELETE, TRUNCATE ON "ledger_accounts", "ledger_transactions", "ledger_entries" FROM mt_app;
REVOKE DELETE, TRUNCATE ON "refunds" FROM mt_app;

-- ---- Erasure (task 5.5): a refund still in progress blocks it like an unfinished payment (plan 3.3, 3.1) ----
CREATE OR REPLACE FUNCTION public.privacy_active_trip_reason(p_customer uuid) RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.bookings b WHERE b."customerId" = p_customer
                   AND b.status IN ('requested', 'approved', 'deposit_paid', 'confirmed')) THEN 'open_booking'
    WHEN EXISTS (SELECT 1 FROM public.bookings b WHERE b."customerId" = p_customer AND b.status = 'balance_paid'
                   AND b."returnDate" >= (pg_catalog.now() AT TIME ZONE 'Australia/Brisbane')::date) THEN 'trip_not_finished'
    WHEN EXISTS (SELECT 1 FROM public.payments p
                  WHERE (p."payerCustomerId" = p_customer OR p."bookingId" IN (SELECT b.id FROM public.bookings b WHERE b."customerId" = p_customer))
                    AND p.status IN ('created', 'pending', 'requires_action'))
      OR EXISTS (SELECT 1 FROM public.refunds r JOIN public.payments p ON p.id = r."paymentId"
                  WHERE (p."payerCustomerId" = p_customer OR r."bookingId" IN (SELECT b.id FROM public.bookings b WHERE b."customerId" = p_customer))
                    AND r.status IN ('requested', 'pending')) THEN 'live_payment'
    -- Money collected on a closed booking may be owed back: the customer's own bookings, and any booking where the
    -- customer is the payer (review m5).
    WHEN EXISTS (SELECT 1 FROM public.bookings b JOIN public.payments p ON p."bookingId" = b.id
                  WHERE (b."customerId" = p_customer OR p."payerCustomerId" = p_customer)
                    AND b.status IN ('cancelled', 'declined', 'expired') AND p.status = 'succeeded') THEN 'refund_may_be_due'
  END
$$;
GRANT SELECT (id, "paymentId", "bookingId", status) ON "refunds" TO mt_privacy;

-- Queue (pg-boss), as declared in src/platform/jobs/queues.ts: the daily ledger check.
SELECT pgboss.create_queue('payments.ledger', '{"policy":"short","retryLimit":1,"retryDelay":300,"expireInSeconds":1800,"deleteAfterSeconds":604800}'::jsonb);
