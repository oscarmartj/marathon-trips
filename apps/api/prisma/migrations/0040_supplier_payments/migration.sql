-- Task 6.2: supplier payments, recorded after the fact (plan docs/plans/6.2-supplier-payments.md). Only adds, except the
-- two ledger trigger functions, which are replaced with their previous body plus the supplier rules. The app never pays a
-- supplier: these rows record payments Oscar made from his bank.

-- Plan review, point 10: guard 4 below only fires on updates, so no cost item may already be marked paid by hand.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "cost_items" WHERE "status" = 'paid') THEN
    RAISE EXCEPTION 'cost items marked paid without a supplier payment exist: fix them before migration 0040';
  END IF;
END $$;

CREATE TYPE "SupplierPaymentStatus" AS ENUM ('recorded', 'voided');

CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "baseAmountMinor" BIGINT,
    "baseCurrency" CHAR(3),
    "paidOn" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'recorded',
    "idempotencyKey" TEXT NOT NULL,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdTxId" BIGINT,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_payment_items" (
    "id" UUID NOT NULL,
    "supplierPaymentId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "costItemId" UUID NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_payments_idempotencyKey_key" ON "supplier_payments"("idempotencyKey");
CREATE INDEX "supplier_payments_supplierId_status_idx" ON "supplier_payments"("supplierId", "status");
CREATE INDEX "supplier_payments_paidOn_idx" ON "supplier_payments"("paidOn");
CREATE UNIQUE INDEX "supplier_payments_id_mode_key" ON "supplier_payments"("id", "mode");
CREATE UNIQUE INDEX "supplier_payments_id_mode_currency_key" ON "supplier_payments"("id", "mode", "currency");
CREATE INDEX "supplier_payment_items_costItemId_idx" ON "supplier_payment_items"("costItemId");
CREATE UNIQUE INDEX "supplier_payment_items_supplierPaymentId_costItemId_key" ON "supplier_payment_items"("supplierPaymentId", "costItemId");
-- Plan 0.1, P12: a cost item is paid by at most one live payment.
CREATE UNIQUE INDEX "supplier_payment_items_active_cost_key" ON "supplier_payment_items"("costItemId") WHERE "active";

ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "supplier_payment_items" ADD CONSTRAINT "supplier_payment_items_supplierPaymentId_mode_currency_fkey" FOREIGN KEY ("supplierPaymentId", "mode", "currency") REFERENCES "supplier_payments"("id", "mode", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "supplier_payment_items" ADD CONSTRAINT "supplier_payment_items_costItemId_currency_fkey" FOREIGN KEY ("costItemId", "currency") REFERENCES "cost_items"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "supplier_payments_base_amount_check" CHECK ("baseAmountMinor" > 0),
  ADD CONSTRAINT "supplier_payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "supplier_payments_base_check" CHECK (("baseAmountMinor" IS NULL) = ("baseCurrency" IS NULL) AND ("baseCurrency" IS NULL OR ("baseCurrency" ~ '^[A-Z]{3}$' AND "baseCurrency" <> "currency"))),
  ADD CONSTRAINT "supplier_payments_reference_check" CHECK (char_length("reference") BETWEEN 1 AND 80),
  ADD CONSTRAINT "supplier_payments_void_check" CHECK (("status" = 'voided') = ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "voidReason" IS NOT NULL)
    AND ("status" = 'voided' OR ("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL))
    AND ("voidReason" IS NULL OR char_length("voidReason") BETWEEN 1 AND 500)),
  ADD CONSTRAINT "supplier_payments_version_check" CHECK ("version" >= 0);
ALTER TABLE "supplier_payment_items"
  ADD CONSTRAINT "supplier_payment_items_amount_check" CHECK ("amountMinor" > 0);

-- ---- Guard 1: a payment is born recorded in its own database transaction and only ever moves recorded -> voided ----
CREATE FUNCTION public.mt_supplier_payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a supplier payment is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'recorded' OR NEW."version" <> 0 THEN
      RAISE EXCEPTION 'a supplier payment starts recorded' USING ERRCODE = 'check_violation';
    END IF;
    NEW."createdTxId" := pg_current_xact_id()::text::bigint;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor" OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."baseAmountMinor" IS DISTINCT FROM OLD."baseAmountMinor" OR NEW."baseCurrency" IS DISTINCT FROM OLD."baseCurrency"
     OR NEW."paidOn" IS DISTINCT FROM OLD."paidOn" OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."recordedById" IS DISTINCT FROM OLD."recordedById"
     OR NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt" OR NEW."createdTxId" IS DISTINCT FROM OLD."createdTxId" THEN
    RAISE EXCEPTION 'a recorded supplier payment is never edited: void it and record it again' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" = OLD."status" THEN
    -- Plan review, point 4: the void fields and the version change only with the status.
    IF NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt" OR NEW."voidedById" IS DISTINCT FROM OLD."voidedById"
       OR NEW."voidReason" IS DISTINCT FROM OLD."voidReason" OR NEW."version" IS DISTINCT FROM OLD."version" THEN
      RAISE EXCEPTION 'the void of a supplier payment is written once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT (OLD."status" = 'recorded' AND NEW."status" = 'voided') THEN
    RAISE EXCEPTION 'supplier payment status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'a change of supplier payment status bumps its version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_payments_guard BEFORE INSERT OR UPDATE OR DELETE ON "supplier_payments"
  FOR EACH ROW EXECUTE FUNCTION public.mt_supplier_payment_guard();
CREATE TRIGGER supplier_payments_no_truncate BEFORE TRUNCATE ON "supplier_payments"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Guard 2: items join a payment only while it is being created, for the whole cost of the supplier's cost item ----
CREATE FUNCTION public.mt_supplier_payment_item_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  parent record;
  cost record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a supplier payment item is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p."status", p."supplierId", p."createdTxId" INTO parent FROM supplier_payments p WHERE p.id = NEW."supplierPaymentId";
  IF TG_OP = 'INSERT' THEN
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a supplier payment item needs its payment' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF parent."status" <> 'recorded' OR parent."createdTxId" IS DISTINCT FROM pg_current_xact_id()::text::bigint OR NOT NEW."active" THEN
      RAISE EXCEPTION 'items are added only while their supplier payment is being recorded' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT c."supplierId", c."amountMinor" INTO cost FROM cost_items c WHERE c.id = NEW."costItemId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a supplier payment item needs its cost item' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF cost."supplierId" <> parent."supplierId" THEN
      RAISE EXCEPTION 'a supplier payment pays only that supplier''s cost items' USING ERRCODE = 'check_violation';
    END IF;
    IF cost."amountMinor" <> NEW."amountMinor" THEN
      RAISE EXCEPTION 'a supplier payment item pays the whole cost item' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."supplierPaymentId" IS DISTINCT FROM OLD."supplierPaymentId" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."costItemId" IS DISTINCT FROM OLD."costItemId" OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'a supplier payment item is never edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."active" IS DISTINCT FROM OLD."active" AND NOT (OLD."active" AND NOT NEW."active" AND parent."status" = 'voided') THEN
    RAISE EXCEPTION 'an item is set inactive only when its payment is voided' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER supplier_payment_items_guard BEFORE INSERT OR UPDATE OR DELETE ON "supplier_payment_items"
  FOR EACH ROW EXECUTE FUNCTION public.mt_supplier_payment_item_guard();
CREATE TRIGGER supplier_payment_items_no_truncate BEFORE TRUNCATE ON "supplier_payment_items"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Guard 3 (deferred): at commit a payment has items and they sum to its amount (plan 0.1, P12) ----
CREATE FUNCTION public.mt_supplier_payment_balanced() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  pid uuid;
  total bigint;
  n integer;
BEGIN
  IF TG_TABLE_NAME = 'supplier_payments' THEN
    pid := NEW.id;
  ELSE
    pid := NEW."supplierPaymentId";
  END IF;
  SELECT count(*), COALESCE(sum("amountMinor"), 0) INTO n, total FROM supplier_payment_items WHERE "supplierPaymentId" = pid;
  IF n = 0 THEN
    RAISE EXCEPTION 'a supplier payment needs at least one item' USING ERRCODE = 'check_violation';
  END IF;
  IF total <> (SELECT "amountMinor" FROM supplier_payments WHERE id = pid) THEN
    RAISE EXCEPTION 'the items of a supplier payment must sum to its amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER supplier_payments_balanced AFTER INSERT ON "supplier_payments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_supplier_payment_balanced();
CREATE CONSTRAINT TRIGGER supplier_payment_items_balanced AFTER INSERT ON "supplier_payment_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_supplier_payment_balanced();

-- ---- Guard 4 (deferred): a cost item is paid if and only if a live payment item points at it ----
CREATE FUNCTION public.mt_cost_item_paid_matches_payment() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cid uuid;
  st text;
  live boolean;
BEGIN
  IF TG_TABLE_NAME = 'cost_items' THEN
    cid := NEW.id;
  ELSE
    cid := NEW."costItemId";
  END IF;
  SELECT c."status"::text INTO st FROM cost_items c WHERE c.id = cid;
  SELECT EXISTS (SELECT 1 FROM supplier_payment_items i WHERE i."costItemId" = cid AND i."active") INTO live;
  IF (st = 'paid') IS DISTINCT FROM live THEN
    RAISE EXCEPTION 'a cost item is paid exactly when a recorded supplier payment pays it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cost_items_paid_matches_payment AFTER INSERT OR UPDATE OF "status" ON "cost_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_cost_item_paid_matches_payment();
CREATE CONSTRAINT TRIGGER supplier_payment_items_paid_matches_cost AFTER INSERT OR UPDATE ON "supplier_payment_items"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.mt_cost_item_paid_matches_payment();

-- ---- Guard 6 (plan review, point 3): what a live payment paid cannot move to another trip, supplier or amount ----
CREATE FUNCTION public.mt_cost_item_paid_frozen() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor" OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
      OR NEW."unitAmountMinor" IS DISTINCT FROM OLD."unitAmountMinor" OR NEW."packageId" IS DISTINCT FROM OLD."packageId"
      OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId" OR NEW."currency" IS DISTINCT FROM OLD."currency")
     AND EXISTS (SELECT 1 FROM supplier_payment_items i WHERE i."costItemId" = OLD.id AND i."active") THEN
    RAISE EXCEPTION 'a paid cost item cannot change its amount, trip, supplier or currency' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cost_items_paid_frozen BEFORE UPDATE ON "cost_items"
  FOR EACH ROW EXECUTE FUNCTION public.mt_cost_item_paid_frozen();

REVOKE DELETE, TRUNCATE ON "supplier_payments", "supplier_payment_items" FROM mt_app;

-- ---- Ledger: postings of supplier payments (never with a booking) ----
ALTER TABLE "ledger_transactions" ADD COLUMN "supplierPaymentId" UUID;
CREATE INDEX "ledger_transactions_supplierPaymentId_idx" ON "ledger_transactions"("supplierPaymentId");
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_supplierPaymentId_mode_fkey" FOREIGN KEY ("supplierPaymentId", "mode") REFERENCES "supplier_payments"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_supplier_payment_check" CHECK ("kind" <> 'supplier_payment' OR ("supplierPaymentId" IS NOT NULL AND "reversesTransactionId" IS NULL)),
  ADD CONSTRAINT "ledger_transactions_supplier_scope_check" CHECK ("supplierPaymentId" IS NULL OR ("bookingId" IS NULL AND "paymentId" IS NULL AND "refundId" IS NULL AND "disputeId" IS NULL AND "kind" IN ('supplier_payment', 'reversal')));

-- The 0035 body, plus: a reversal carries the supplier payment of what it reverses.
CREATE OR REPLACE FUNCTION public.mt_ledger_transaction_insert() RETURNS trigger
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
  IF NEW."disputeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.id = NEW."disputeId" AND d."bookingId" = NEW."bookingId") THEN
    RAISE EXCEPTION 'a ledger transaction belongs to the booking of its dispute' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversesTransactionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_transactions o WHERE o.id = NEW."reversesTransactionId" AND o."bookingId" IS NOT DISTINCT FROM NEW."bookingId") THEN
    RAISE EXCEPTION 'a reversal belongs to the booking of what it reverses' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reversesTransactionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_transactions o WHERE o.id = NEW."reversesTransactionId" AND o."supplierPaymentId" IS NOT DISTINCT FROM NEW."supplierPaymentId") THEN
    RAISE EXCEPTION 'a reversal belongs to the supplier payment of what it reverses' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The 0033 body, plus: the entries of a supplier payment are in its currency or in the currency of its bank side.
CREATE OR REPLACE FUNCTION public.mt_ledger_entry_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  parent record;
BEGIN
  SELECT t."createdTxId", t."bookingId", t."paymentId", t."supplierPaymentId" INTO parent FROM ledger_transactions t WHERE t.id = NEW."transactionId";
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
  IF parent."supplierPaymentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM supplier_payments s WHERE s.id = parent."supplierPaymentId" AND (s.currency = NEW."currency" OR s."baseCurrency" = NEW."currency")) THEN
    RAISE EXCEPTION 'the entries of a supplier payment are in its currency or its bank currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Queue (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('suppliers.payment_alerts', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
