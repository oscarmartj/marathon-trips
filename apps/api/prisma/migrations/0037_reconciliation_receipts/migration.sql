-- Task 4.6: gateway settlements and their fees, daily reconciliation runs, receipts and notes
-- (plan docs/plans/4.6-reconciliation-receipts.md, sections 3 and 12). Only adds. Provider accounts keep CHECK (mode = 'test').
-- No GST: registration cannot be switched on in 4.6, so every document records gstRegisteredAtIssue = false.

CREATE TYPE "SettlementLineKind" AS ENUM ('charge', 'refund', 'dispute_withdrawal', 'dispute_reinstatement', 'adjustment', 'other');
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('running', 'matched', 'mismatch', 'partial', 'failed', 'not_applicable');
CREATE TYPE "ReconciliationTrigger" AS ENUM ('scheduled', 'manual');
CREATE TYPE "ReceiptNoteKind" AS ENUM ('refund', 'refund_reversal', 'chargeback', 'chargeback_reinstatement', 'void');
CREATE TYPE "ReceiptNoteDirection" AS ENUM ('decrease', 'increase');

-- ---- A receipt carries its payment's booking, mode, currency and amount ----
CREATE UNIQUE INDEX "payments_id_bookingId_mode_currency_amountMinor_key" ON "payments"("id", "bookingId", "mode", "currency", "amountMinor");

-- ---- Settlements ----
CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "providerSettlementRef" TEXT NOT NULL,
    "payoutDate" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "grossMinor" BIGINT NOT NULL,
    "feesMinor" BIGINT NOT NULL,
    "netMinor" BIGINT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlements_providerAccountId_providerSettlementRef_key" ON "settlements"("providerAccountId", "providerSettlementRef");
CREATE UNIQUE INDEX "settlements_id_mode_currency_key" ON "settlements"("id", "mode", "currency");
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_providerAccountId_mode_fkey" FOREIGN KEY ("providerAccountId", "mode") REFERENCES "provider_accounts"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "settlements"
  ADD CONSTRAINT "settlements_net_check" CHECK ("netMinor" = "grossMinor" - "feesMinor"),
  ADD CONSTRAINT "settlements_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "settlements_text_check" CHECK (char_length("providerSettlementRef") BETWEEN 1 AND 255 AND "contentSha256" ~ '^[0-9a-f]{64}$');

CREATE TABLE "settlement_lines" (
    "id" UUID NOT NULL,
    "settlementId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "providerLineRef" TEXT NOT NULL,
    "kind" "SettlementLineKind" NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "feeMinor" BIGINT NOT NULL,
    "paymentRef" TEXT,
    "refundRef" TEXT,
    "disputeRef" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlement_lines_settlementId_providerLineRef_key" ON "settlement_lines"("settlementId", "providerLineRef");
CREATE UNIQUE INDEX "settlement_lines_id_mode_key" ON "settlement_lines"("id", "mode");
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlementId_mode_currency_fkey" FOREIGN KEY ("settlementId", "mode", "currency") REFERENCES "settlements"("id", "mode", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "settlement_lines"
  ADD CONSTRAINT "settlement_lines_refs_check" CHECK (num_nonnulls("refundRef", "disputeRef") <= 1),
  ADD CONSTRAINT "settlement_lines_text_check" CHECK (char_length("providerLineRef") BETWEEN 1 AND 255
    AND ("paymentRef" IS NULL OR char_length("paymentRef") <= 255) AND ("refundRef" IS NULL OR char_length("refundRef") <= 255) AND ("disputeRef" IS NULL OR char_length("disputeRef") <= 255));

-- What a line matched, once. The guard checks the booking, the mode and the currency against what it names.
CREATE TABLE "settlement_line_matches" (
    "id" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "paymentId" UUID,
    "refundId" UUID,
    "disputeId" UUID,
    "bookingId" UUID NOT NULL,
    "matchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_line_matches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlement_line_matches_lineId_key" ON "settlement_line_matches"("lineId");
CREATE INDEX "settlement_line_matches_paymentId_idx" ON "settlement_line_matches"("paymentId");
CREATE INDEX "settlement_line_matches_refundId_idx" ON "settlement_line_matches"("refundId");
CREATE INDEX "settlement_line_matches_disputeId_idx" ON "settlement_line_matches"("disputeId");
CREATE INDEX "settlement_line_matches_bookingId_idx" ON "settlement_line_matches"("bookingId");
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_lineId_mode_fkey" FOREIGN KEY ("lineId", "mode") REFERENCES "settlement_lines"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_paymentId_mode_fkey" FOREIGN KEY ("paymentId", "mode") REFERENCES "payments"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_refundId_mode_fkey" FOREIGN KEY ("refundId", "mode") REFERENCES "refunds"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_disputeId_mode_fkey" FOREIGN KEY ("disputeId", "mode") REFERENCES "disputes"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_one_check" CHECK (num_nonnulls("paymentId", "refundId", "disputeId") = 1);

CREATE FUNCTION public.mt_settlement_match_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  line_currency char(3);
  target_booking uuid;
  target_currency char(3);
BEGIN
  SELECT l.currency INTO line_currency FROM settlement_lines l WHERE l.id = NEW."lineId";
  IF NEW."paymentId" IS NOT NULL THEN
    SELECT p."bookingId", p.currency INTO target_booking, target_currency FROM payments p WHERE p.id = NEW."paymentId";
  ELSIF NEW."refundId" IS NOT NULL THEN
    SELECT r."bookingId", r.currency INTO target_booking, target_currency FROM refunds r WHERE r.id = NEW."refundId";
  ELSE
    SELECT d."bookingId", d.currency INTO target_booking, target_currency FROM disputes d WHERE d.id = NEW."disputeId";
  END IF;
  IF target_booking IS DISTINCT FROM NEW."bookingId" THEN
    RAISE EXCEPTION 'a settlement match carries the booking of what it matched' USING ERRCODE = 'check_violation';
  END IF;
  -- Review R3: a line in another currency than what it names is a difference, never a match.
  IF target_currency IS DISTINCT FROM line_currency THEN
    RAISE EXCEPTION 'a settlement line matches only an object in its currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settlement_line_matches_insert BEFORE INSERT ON "settlement_line_matches"
  FOR EACH ROW EXECUTE FUNCTION public.mt_settlement_match_insert();

-- ---- Reconciliation runs ----
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "providerAccountId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "forDate" DATE NOT NULL,
    "attempt" INTEGER NOT NULL,
    "trigger" "ReconciliationTrigger" NOT NULL,
    "triggeredById" UUID,
    "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'running',
    "errorCode" TEXT,
    "checkedObjects" INTEGER NOT NULL DEFAULT 0,
    "differences" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reconciliation_runs_providerAccountId_forDate_attempt_key" ON "reconciliation_runs"("providerAccountId", "forDate", "attempt");
CREATE INDEX "reconciliation_runs_status_idx" ON "reconciliation_runs"("status");
-- Review R11: one running reconciliation per account at a time.
CREATE UNIQUE INDEX "reconciliation_runs_one_running" ON "reconciliation_runs"("providerAccountId") WHERE "status" = 'running';
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_providerAccountId_mode_fkey" FOREIGN KEY ("providerAccountId", "mode") REFERENCES "provider_accounts"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "reconciliation_runs"
  ADD CONSTRAINT "reconciliation_runs_attempt_check" CHECK ("attempt" >= 1),
  ADD CONSTRAINT "reconciliation_runs_checked_check" CHECK ("checkedObjects" >= 0),
  ADD CONSTRAINT "reconciliation_runs_error_check" CHECK ("errorCode" IS NULL OR "errorCode" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "reconciliation_runs_differences_check" CHECK (jsonb_typeof("differences") = 'array'),
  ADD CONSTRAINT "reconciliation_runs_finished_check" CHECK (("status" = 'running') = ("finishedAt" IS NULL));

CREATE FUNCTION public.mt_reconciliation_run_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a reconciliation run is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'running' OR NEW."differences" <> '[]'::jsonb OR NEW."checkedObjects" <> 0 THEN
      RAISE EXCEPTION 'a reconciliation run starts running and empty' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- Closed once: from running to a final status, with its counts and differences. Then never again.
  IF OLD."status" <> 'running' OR NEW."status" = 'running'
     OR NEW."id" IS DISTINCT FROM OLD."id" OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."forDate" IS DISTINCT FROM OLD."forDate" OR NEW."attempt" IS DISTINCT FROM OLD."attempt" OR NEW."trigger" IS DISTINCT FROM OLD."trigger"
     OR NEW."triggeredById" IS DISTINCT FROM OLD."triggeredById" OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'a reconciliation run is only closed, once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reconciliation_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON "reconciliation_runs"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reconciliation_run_guard();
CREATE TRIGGER reconciliation_runs_no_truncate BEFORE TRUNCATE ON "reconciliation_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- ---- Receipts and notes ----
CREATE TABLE "receipt_numbers" (
    "number" TEXT NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_numbers_pkey" PRIMARY KEY ("number")
);
ALTER TABLE "receipt_numbers"
  ADD CONSTRAINT "receipt_numbers_kind_check" CHECK ("kind" IN ('receipt', 'note')),
  ADD CONSTRAINT "receipt_numbers_format_check" CHECK (("mode" = 'test' AND "number" ~ '^MT-T-[1-9][0-9]{0,17}$') OR ("mode" = 'live' AND "number" ~ '^MT-R-[1-9][0-9]{0,17}$'));

CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "bookingId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "causeKey" TEXT NOT NULL,
    "fundsAfterMinor" BIGINT NOT NULL,
    "gstRegisteredAtIssue" BOOLEAN NOT NULL DEFAULT false,
    "content" JSONB NOT NULL,
    "layoutVersion" INTEGER NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receipts_number_key" ON "receipts"("number");
CREATE UNIQUE INDEX "receipts_paymentId_key" ON "receipts"("paymentId");
CREATE UNIQUE INDEX "receipts_causeKey_key" ON "receipts"("causeKey");
CREATE UNIQUE INDEX "receipts_id_bookingId_mode_currency_key" ON "receipts"("id", "bookingId", "mode", "currency");
CREATE INDEX "receipts_bookingId_idx" ON "receipts"("bookingId");
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_number_fkey" FOREIGN KEY ("number") REFERENCES "receipt_numbers"("number") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_paymentId_bookingId_mode_currency_amountMinor_fkey" FOREIGN KEY ("paymentId", "bookingId", "mode", "currency", "amountMinor") REFERENCES "payments"("id", "bookingId", "mode", "currency", "amountMinor") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "receipts_funds_check" CHECK ("fundsAfterMinor" >= 0),
  ADD CONSTRAINT "receipts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  -- Review R7: GST registration cannot be switched on in 4.6, so no document is issued as registered.
  ADD CONSTRAINT "receipts_gst_check" CHECK ("gstRegisteredAtIssue" = false),
  ADD CONSTRAINT "receipts_cause_check" CHECK ("causeKey" = 'payment:' || "paymentId"::text || ':succeeded'),
  ADD CONSTRAINT "receipts_text_check" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$' AND "layoutVersion" >= 1 AND jsonb_typeof("content") = 'object');

CREATE TABLE "receipt_notes" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ReceiptNoteKind" NOT NULL,
    "direction" "ReceiptNoteDirection" NOT NULL,
    "receiptId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "refundId" UUID,
    "disputeId" UUID,
    "causeKey" TEXT NOT NULL,
    "fundsAfterMinor" BIGINT NOT NULL,
    "gstRegisteredAtIssue" BOOLEAN NOT NULL DEFAULT false,
    "content" JSONB NOT NULL,
    "layoutVersion" INTEGER NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_notes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "receipt_notes_number_key" ON "receipt_notes"("number");
CREATE UNIQUE INDEX "receipt_notes_causeKey_key" ON "receipt_notes"("causeKey");
CREATE INDEX "receipt_notes_receiptId_idx" ON "receipt_notes"("receiptId");
CREATE INDEX "receipt_notes_bookingId_idx" ON "receipt_notes"("bookingId");
-- Review R12 (a): a receipt is cancelled once.
CREATE UNIQUE INDEX "receipt_notes_one_void" ON "receipt_notes"("receiptId") WHERE "kind" = 'void';
ALTER TABLE "receipt_notes" ADD CONSTRAINT "receipt_notes_number_fkey" FOREIGN KEY ("number") REFERENCES "receipt_numbers"("number") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "receipt_notes" ADD CONSTRAINT "receipt_notes_receiptId_bookingId_mode_currency_fkey" FOREIGN KEY ("receiptId", "bookingId", "mode", "currency") REFERENCES "receipts"("id", "bookingId", "mode", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "receipt_notes" ADD CONSTRAINT "receipt_notes_refundId_mode_fkey" FOREIGN KEY ("refundId", "mode") REFERENCES "refunds"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "receipt_notes" ADD CONSTRAINT "receipt_notes_disputeId_mode_fkey" FOREIGN KEY ("disputeId", "mode") REFERENCES "disputes"("id", "mode") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "receipt_notes"
  ADD CONSTRAINT "receipt_notes_amount_check" CHECK ("amountMinor" > 0),
  ADD CONSTRAINT "receipt_notes_funds_check" CHECK ("fundsAfterMinor" >= 0),
  ADD CONSTRAINT "receipt_notes_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "receipt_notes_gst_check" CHECK ("gstRegisteredAtIssue" = false),
  ADD CONSTRAINT "receipt_notes_text_check" CHECK ("contentSha256" ~ '^[0-9a-f]{64}$' AND "layoutVersion" >= 1 AND jsonb_typeof("content") = 'object' AND char_length("causeKey") BETWEEN 1 AND 200),
  ADD CONSTRAINT "receipt_notes_kind_check" CHECK (
    ("kind" IN ('refund', 'refund_reversal') AND "refundId" IS NOT NULL AND "disputeId" IS NULL)
    OR ("kind" IN ('chargeback', 'chargeback_reinstatement') AND "disputeId" IS NOT NULL AND "refundId" IS NULL)
    OR ("kind" = 'void' AND "refundId" IS NULL AND "disputeId" IS NULL)),
  ADD CONSTRAINT "receipt_notes_direction_check" CHECK (("direction" = 'decrease') = ("kind" IN ('refund', 'chargeback', 'void')));

-- The number a document uses was taken for that kind and mode; a note names the receipt of what it is about.
CREATE FUNCTION public.mt_receipt_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM receipt_numbers n WHERE n.number = NEW."number" AND n.mode = NEW.mode AND n.kind = 'receipt') THEN
    RAISE EXCEPTION 'a receipt uses a number taken for receipts in its mode' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.mt_receipt_note_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM receipt_numbers n WHERE n.number = NEW."number" AND n.mode = NEW.mode AND n.kind = 'note') THEN
    RAISE EXCEPTION 'a note uses a number taken for notes in its mode' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."refundId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM refunds r JOIN receipts c ON c."paymentId" = r."paymentId" WHERE r.id = NEW."refundId" AND c.id = NEW."receiptId") THEN
    RAISE EXCEPTION 'a refund note references the receipt of the refunded payment' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."disputeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM disputes d JOIN receipts c ON c."paymentId" = d."paymentId" WHERE d.id = NEW."disputeId" AND c.id = NEW."receiptId") THEN
    RAISE EXCEPTION 'a chargeback note references the receipt of the disputed payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipts_insert BEFORE INSERT ON "receipts" FOR EACH ROW EXECUTE FUNCTION public.mt_receipt_insert();
CREATE TRIGGER receipt_notes_insert BEFORE INSERT ON "receipt_notes" FOR EACH ROW EXECUTE FUNCTION public.mt_receipt_note_insert();

-- ---- Never changed, never deleted (review R12 f: triggers for every role, and no UPDATE/DELETE for the API role) ----
CREATE TRIGGER settlements_append_only BEFORE UPDATE OR DELETE ON "settlements" FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER settlements_no_truncate BEFORE TRUNCATE ON "settlements" FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER settlement_lines_append_only BEFORE UPDATE OR DELETE ON "settlement_lines" FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER settlement_lines_no_truncate BEFORE TRUNCATE ON "settlement_lines" FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER settlement_line_matches_append_only BEFORE UPDATE OR DELETE ON "settlement_line_matches" FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER settlement_line_matches_no_truncate BEFORE TRUNCATE ON "settlement_line_matches" FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER receipt_numbers_append_only BEFORE UPDATE OR DELETE ON "receipt_numbers" FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER receipt_numbers_no_truncate BEFORE TRUNCATE ON "receipt_numbers" FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER receipts_append_only BEFORE UPDATE OR DELETE ON "receipts" FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON "receipts" FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER receipt_notes_append_only BEFORE UPDATE OR DELETE ON "receipt_notes" FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER receipt_notes_no_truncate BEFORE TRUNCATE ON "receipt_notes" FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
REVOKE UPDATE, DELETE, TRUNCATE ON "settlements", "settlement_lines", "settlement_line_matches", "receipt_numbers", "receipts", "receipt_notes" FROM mt_app;
REVOKE DELETE, TRUNCATE ON "reconciliation_runs" FROM mt_app;

-- ---- One numbering per mode for receipts and notes ----
INSERT INTO "number_sequences" ("id", "key", "prefix", "nextValue", "updatedAt") VALUES
  (gen_random_uuid(), 'receipts:test', 'MT-T-', 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'receipts:live', 'MT-R-', 1, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Queues (pg-boss), as declared in src/platform/jobs/queues.ts: the daily reconciliation and the hourly receipt sweep.
SELECT pgboss.create_queue('payments.reconciliation', '{"policy":"short","retryLimit":0,"retryDelay":300,"expireInSeconds":7200,"deleteAfterSeconds":604800}'::jsonb);
SELECT pgboss.create_queue('payments.receipts', '{"policy":"short","retryLimit":1,"retryDelay":120,"expireInSeconds":1800,"deleteAfterSeconds":604800}'::jsonb);
