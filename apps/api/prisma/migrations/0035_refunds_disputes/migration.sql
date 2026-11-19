-- Task 4.5: refunds started from the app (gateway and manual), disputes and chargebacks (plan
-- docs/plans/4.5-refunds-disputes.md, sections 1 and 14).

-- ---- Refunds: app refunds, manual refund destination, retries ----
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'evidence_submitted', 'won', 'lost', 'closed');

ALTER TABLE "refunds"
  ADD COLUMN "manualRefund" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "destinationCiphertext" TEXT,
  ADD COLUMN "destinationKeyVersion" INTEGER,
  ADD COLUMN "destinationHint" TEXT,
  ADD COLUMN "confirmedById" UUID,
  ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "requestAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "refunds" DROP CONSTRAINT "refunds_origin_check";
ALTER TABLE "refunds"
  -- Until 6.4 (cancellation) and the courtesy-refund task (price reduction), the app only returns overpayments (P9).
  ADD CONSTRAINT "refunds_purpose_scope_check" CHECK ("purpose" IS NULL OR "purpose" = 'overpayment_return'),
  ADD CONSTRAINT "refunds_manual_check" CHECK (NOT "manualRefund" OR "origin" = 'app'),
  ADD CONSTRAINT "refunds_destination_check" CHECK (
    (("destinationCiphertext" IS NULL) = ("destinationKeyVersion" IS NULL))
    AND ("destinationCiphertext" IS NULL OR ("manualRefund" AND "status" = 'requested'))
    AND ("destinationHint" IS NULL OR "manualRefund")
    AND ("destinationHint" IS NULL OR char_length("destinationHint") <= 80)),
  ADD CONSTRAINT "refunds_attempts_check" CHECK ("requestAttempts" >= 0 AND ("nextAttemptAt" IS NULL OR ("origin" = 'app' AND NOT "manualRefund")));

CREATE INDEX "refunds_nextAttemptAt_idx" ON "refunds"("nextAttemptAt");
-- A bank statement movement id is one outgoing transfer, whatever manual account it is recorded on (plan review, 8).
CREATE UNIQUE INDEX "refunds_manual_reference_key" ON "refunds"("providerRefundRef") WHERE "manualRefund";

-- Replaces 0033's guard: app refunds start requested with a reason; the destination only goes away.
CREATE OR REPLACE FUNCTION public.mt_refund_guard() RETURNS trigger
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
    IF NEW."origin" = 'app' AND (NEW."status" <> 'requested' OR NEW."providerRefundRef" IS NOT NULL OR NEW."reason" IS NULL
        OR char_length(btrim(NEW."reason")) < 3 OR char_length(NEW."reason") > 500 OR NEW."requestedById" IS NULL
        OR NEW."confirmedById" IS NOT NULL OR NEW."destinationCiphertext" IS NOT NULL) THEN
      RAISE EXCEPTION 'an app refund starts requested, with a reason and the staff who asked' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
     OR NEW."origin" IS DISTINCT FROM OLD."origin" OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById" OR NEW."manualRefund" IS DISTINCT FROM OLD."manualRefund"
     OR (OLD."providerRefundRef" IS NOT NULL AND NEW."providerRefundRef" IS DISTINCT FROM OLD."providerRefundRef")
     OR (OLD."succeededAt" IS NOT NULL AND NEW."succeededAt" IS DISTINCT FROM OLD."succeededAt")
     OR (OLD."confirmedById" IS NOT NULL AND NEW."confirmedById" IS DISTINCT FROM OLD."confirmedById")
     OR NEW."requestAttempts" < OLD."requestAttempts" THEN
    RAISE EXCEPTION 'the identity of a refund never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The reason and the hint are personal data: erasure may only empty them.
  IF NEW."reason" IS DISTINCT FROM OLD."reason" AND NEW."reason" IS NOT NULL THEN
    RAISE EXCEPTION 'a refund reason is never rewritten' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."destinationHint" IS DISTINCT FROM OLD."destinationHint" AND (NEW."destinationHint" IS NOT NULL AND OLD."destinationHint" IS NOT NULL) THEN
    RAISE EXCEPTION 'a refund destination is set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The destination is set once, while requested, and then only removed.
  IF NEW."destinationCiphertext" IS DISTINCT FROM OLD."destinationCiphertext" AND NEW."destinationCiphertext" IS NOT NULL
     AND (OLD."destinationCiphertext" IS NOT NULL OR OLD."destinationHint" IS NOT NULL OR NOT OLD."manualRefund" OR OLD."status" <> 'requested') THEN
    RAISE EXCEPTION 'a refund destination is set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."destinationHint" IS NOT NULL AND OLD."destinationHint" IS NULL AND NEW."destinationCiphertext" IS NULL THEN
    RAISE EXCEPTION 'a refund destination comes with its hint' USING ERRCODE = 'check_violation';
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
    -- A manual refund succeeds only with its bank reference and the staff who confirmed it.
    IF OLD."manualRefund" AND NEW."status" = 'succeeded' AND (NEW."confirmedById" IS NULL OR NEW."providerRefundRef" IS NULL) THEN
      RAISE EXCEPTION 'a manual refund is confirmed with a bank reference' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Disputes ----
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "providerDisputeRef" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL,
    "evidenceDueBy" TIMESTAMPTZ(3),
    "evidenceSubmittedAt" TIMESTAMPTZ(3),
    "evidenceSubmittedById" UUID,
    "fundsWithdrawnAt" TIMESTAMPTZ(3),
    "fundsReinstatedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "disputes_id_mode_key" ON "disputes"("id", "mode");
CREATE UNIQUE INDEX "disputes_providerAccountId_providerDisputeRef_key" ON "disputes"("providerAccountId", "providerDisputeRef");
CREATE INDEX "disputes_bookingId_idx" ON "disputes"("bookingId");
CREATE INDEX "disputes_paymentId_idx" ON "disputes"("paymentId");
CREATE INDEX "disputes_status_idx" ON "disputes"("status");
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_fkey" FOREIGN KEY ("paymentId", "bookingId", "providerAccountId", "mode", "currency") REFERENCES "payments"("id", "bookingId", "providerAccountId", "mode", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "disputes_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "disputes_reason_check" CHECK ("reasonCode" IN ('fraudulent', 'product_not_received', 'product_unacceptable', 'duplicate', 'credit_not_processed', 'unrecognised', 'general', 'other')),
  ADD CONSTRAINT "disputes_ref_check" CHECK (char_length("providerDisputeRef") BETWEEN 1 AND 255),
  ADD CONSTRAINT "disputes_funds_check" CHECK ("fundsReinstatedAt" IS NULL OR "fundsWithdrawnAt" IS NOT NULL);

CREATE FUNCTION public.mt_dispute_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a dispute is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."paymentId" IS DISTINCT FROM OLD."paymentId" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."providerDisputeRef" IS DISTINCT FROM OLD."providerDisputeRef"
     OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."fundsWithdrawnAt" IS NOT NULL AND NEW."fundsWithdrawnAt" IS DISTINCT FROM OLD."fundsWithdrawnAt")
     OR (OLD."fundsReinstatedAt" IS NOT NULL AND NEW."fundsReinstatedAt" IS DISTINCT FROM OLD."fundsReinstatedAt")
     OR (OLD."evidenceSubmittedAt" IS NOT NULL AND NEW."evidenceSubmittedAt" IS DISTINCT FROM OLD."evidenceSubmittedAt")
     OR (OLD."evidenceSubmittedById" IS NOT NULL AND NEW."evidenceSubmittedById" IS DISTINCT FROM OLD."evidenceSubmittedById") THEN
    RAISE EXCEPTION 'the identity of a dispute never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT ((OLD."status", NEW."status") IN (
      ('open'::"DisputeStatus", 'evidence_submitted'::"DisputeStatus"), ('open', 'won'), ('open', 'lost'), ('open', 'closed'),
      ('evidence_submitted', 'won'), ('evidence_submitted', 'lost'), ('evidence_submitted', 'closed')
    )) THEN
      RAISE EXCEPTION 'dispute status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION 'a change of a dispute bumps its version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER disputes_guard BEFORE INSERT OR UPDATE OR DELETE ON "disputes"
  FOR EACH ROW EXECUTE FUNCTION public.mt_dispute_guard();
CREATE TRIGGER disputes_no_truncate BEFORE TRUNCATE ON "disputes"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
REVOKE DELETE, TRUNCATE ON "disputes" FROM mt_app;

-- ---- Ledger: chargebacks name their dispute ----
ALTER TABLE "ledger_transactions" ADD COLUMN "disputeId" UUID;
CREATE INDEX "ledger_transactions_disputeId_idx" ON "ledger_transactions"("disputeId");
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_disputeId_mode_fkey" FOREIGN KEY ("disputeId", "mode") REFERENCES "disputes"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_booking_check";
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_chargeback_check" CHECK ("kind" <> 'chargeback' OR "disputeId" IS NOT NULL),
  ADD CONSTRAINT "ledger_transactions_booking_check" CHECK (("paymentId" IS NULL AND "refundId" IS NULL AND "disputeId" IS NULL) OR "bookingId" IS NOT NULL);

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
  RETURN NEW;
END;
$$;

-- ---- Webhook events: the dispute link is set once (replaces the 0033 guard) ----
ALTER TABLE "webhook_events" ADD COLUMN "disputeId" UUID;
CREATE INDEX "webhook_events_disputeId_idx" ON "webhook_events"("disputeId");
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
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
     OR (OLD."refundId" IS NOT NULL AND NEW."refundId" IS DISTINCT FROM OLD."refundId")
     OR (OLD."disputeId" IS NOT NULL AND NEW."disputeId" IS DISTINCT FROM OLD."disputeId") THEN
    RAISE EXCEPTION 'a webhook event is never edited, only matched and processed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Erasure (task 5.5): an open dispute of the customer's bookings or payments blocks it, and a credit is what was
-- collected net of refunds and chargebacks. Replaces the 0033 version, which it keeps otherwise. ----
GRANT SELECT (id, "paymentId", "bookingId", status, "amountMinor", "fundsWithdrawnAt", "fundsReinstatedAt") ON "disputes" TO mt_privacy;
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
    -- Task 4.5: a dispute still open, opened on the customer's booking or on a payment the customer made.
    WHEN EXISTS (SELECT 1 FROM public.disputes d JOIN public.payments p ON p.id = d."paymentId"
                  WHERE (p."payerCustomerId" = p_customer OR d."bookingId" IN (SELECT b.id FROM public.bookings b WHERE b."customerId" = p_customer))
                    AND d.status IN ('open', 'evidence_submitted')) THEN 'open_dispute'
    WHEN EXISTS (SELECT 1 FROM public.bookings b JOIN public.payments p ON p."bookingId" = b.id
                  WHERE (b."customerId" = p_customer OR p."payerCustomerId" = p_customer)
                    AND b.status IN ('cancelled', 'declined', 'expired') AND p.status = 'succeeded') THEN 'refund_may_be_due'
    WHEN EXISTS (SELECT 1 FROM public.bookings b
                  WHERE (b."customerId" = p_customer OR EXISTS (SELECT 1 FROM public.payments q WHERE q."bookingId" = b.id AND q."payerCustomerId" = p_customer))
                    AND (SELECT COALESCE(sum(p."amountMinor"), 0) FROM public.payments p WHERE p."bookingId" = b.id AND p.status = 'succeeded')
                        - (SELECT COALESCE(sum(r."amountMinor"), 0) FROM public.refunds r WHERE r."bookingId" = b.id AND r.status = 'succeeded')
                        - (SELECT COALESCE(sum(d."amountMinor"), 0) FROM public.disputes d WHERE d."bookingId" = b.id AND d."fundsWithdrawnAt" IS NOT NULL AND d."fundsReinstatedAt" IS NULL)
                        > b."totalMinor") THEN 'refund_may_be_due'
  END
$$;
