-- Task 5.5: privacy (plan docs/plans/5.5-privacy-export-erase.md). Requests to export or erase, the marketing consent
-- record, the shared "active trip" rule, the erasure functions owned by mt_privacy and the trigger that stops anything
-- new from being written for an erased customer.

-- CreateEnum
CREATE TYPE "PrivacyRequestKind" AS ENUM ('export', 'erasure');
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('received', 'completed');
CREATE TYPE "PrivacyRequester" AS ENUM ('customer', 'staff');
CREATE TYPE "ConsentPurpose" AS ENUM ('marketing_email');
CREATE TYPE "ConsentSource" AS ENUM ('account', 'unsubscribe_link', 'erasure');

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL,
    "customerId" UUID,
    "userId" UUID,
    "kind" "PrivacyRequestKind" NOT NULL,
    "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'received',
    "requestedBy" "PrivacyRequester" NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "actorUserId" UUID,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "customerId" UUID,
    "emailHash" TEXT NOT NULL,
    "emailHashKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "wordingKey" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "privacy_requests_customerId_kind_status_idx" ON "privacy_requests"("customerId", "kind", "status");
CREATE INDEX "privacy_requests_status_requestedAt_idx" ON "privacy_requests"("status", "requestedAt");
CREATE INDEX "consent_records_customerId_purpose_recordedAt_idx" ON "consent_records"("customerId", "purpose", "recordedAt");
CREATE INDEX "consent_records_emailHash_purpose_recordedAt_idx" ON "consent_records"("emailHash", "purpose", "recordedAt");

-- AddForeignKey
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints that Prisma cannot express.
-- A request belongs to a customer or, for an account with no customer record, to a sign-in account; one open erasure
-- request per customer; completedAt goes with completed.
ALTER TABLE "privacy_requests"
  ADD CONSTRAINT "privacy_requests_subject_check" CHECK ("customerId" IS NOT NULL OR "userId" IS NOT NULL),
  ADD CONSTRAINT "privacy_requests_completed_check" CHECK (("status" = 'completed') = ("completedAt" IS NOT NULL));
CREATE UNIQUE INDEX "privacy_requests_one_open_erasure" ON "privacy_requests"("customerId") WHERE "kind" = 'erasure' AND "status" = 'received';
-- The hash is hex; the wording key is a code; an erasure record is always a withdrawal.
ALTER TABLE "consent_records"
  ADD CONSTRAINT "consent_records_hash_check" CHECK ("emailHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "consent_records_wording_check" CHECK ("wordingKey" ~ '^[a-z][a-z0-9_.]{0,63}$'),
  ADD CONSTRAINT "consent_records_erasure_withdraws_check" CHECK ("source" <> 'erasure' OR NOT "granted");

-- A request is never deleted; only received -> completed, once, with its completion time and actor.
CREATE FUNCTION public.mt_privacy_request_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a privacy request is never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (OLD."status" = 'received' AND NEW."status" = 'completed')
     OR (pg_catalog.to_jsonb(NEW) - 'status' - 'completedAt' - 'actorUserId') <> (pg_catalog.to_jsonb(OLD) - 'status' - 'completedAt' - 'actorUserId') THEN
    RAISE EXCEPTION 'a privacy request only goes from received to completed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER privacy_requests_guard BEFORE UPDATE OR DELETE ON "privacy_requests"
  FOR EACH ROW EXECUTE FUNCTION public.mt_privacy_request_guard();
CREATE TRIGGER privacy_requests_no_truncate BEFORE TRUNCATE ON "privacy_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Consent records are evidence (Spam Act 2003): never edited or deleted, by anyone. The one exception (plan 0.1, 4.9):
-- erasure, inside privacy_erase_customer (current_user = mt_privacy), clears customerId and nothing else.
CREATE FUNCTION public.mt_consent_record_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_user = 'mt_privacy' AND NEW."customerId" IS NULL
     AND (pg_catalog.to_jsonb(NEW) - 'customerId') = (pg_catalog.to_jsonb(OLD) - 'customerId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION public.mt_consent_record_guard();
CREATE TRIGGER consent_records_no_truncate BEFORE TRUNCATE ON "consent_records"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
REVOKE UPDATE, DELETE ON "consent_records" FROM mt_app;
REVOKE DELETE ON "privacy_requests" FROM mt_app;

-- ---- Nothing new for an erased customer ----
-- Services lock the customer and refuse an anonymised one; this catches any path that read the customer before an
-- erasure and writes after it. The FOR KEY SHARE read waits for an erasure in progress (which holds the customer FOR
-- UPDATE) and then sees its result. TG_ARGV[0] names the column holding the customer id.
CREATE FUNCTION public.mt_customer_not_erased() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_customer uuid := (pg_catalog.to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  v_erased timestamptz;
BEGIN
  IF v_customer IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT c."anonymisedAt" INTO v_erased FROM public.customers c WHERE c.id = v_customer FOR KEY SHARE;
  IF v_erased IS NOT NULL THEN
    RAISE EXCEPTION 'customer_erased' USING ERRCODE = 'MT409';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.mt_customer_not_erased() FROM PUBLIC;

CREATE TRIGGER bookings_customer_not_erased BEFORE INSERT OR UPDATE OF "customerId" ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER quotes_customer_not_erased BEFORE INSERT OR UPDATE OF "customerId" ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER waitlist_entries_customer_not_erased BEFORE INSERT ON "waitlist_entries"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER payments_customer_not_erased BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('payerCustomerId');
CREATE TRIGGER terms_acceptances_customer_not_erased BEFORE INSERT ON "terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER promo_redemptions_customer_not_erased BEFORE INSERT ON "promo_redemptions"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER consent_records_customer_not_erased BEFORE INSERT ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER complaints_customer_not_erased BEFORE INSERT OR UPDATE OF "customerId" ON "complaints"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER outbound_emails_customer_not_erased BEFORE INSERT OR UPDATE OF "customerId" ON "outbound_emails"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');
CREATE TRIGGER travellers_customer_not_erased BEFORE INSERT OR UPDATE OF "customerId" ON "travellers"
  FOR EACH ROW EXECUTE FUNCTION public.mt_customer_not_erased('customerId');

-- ---- The active-trip rule (plan 5.5, section 2.2), shared by the API (for its 409) and privacy_erase_customer ----
-- NULL when the customer may be erased; otherwise the reason code.
CREATE FUNCTION public.privacy_active_trip_reason(p_customer uuid) RETURNS text
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
                    AND p.status IN ('created', 'pending', 'requires_action')) THEN 'live_payment'
    -- Money collected on a closed booking may be owed back (refunds are parked): the customer's own bookings, and any
    -- booking where the customer is the payer (review m5).
    WHEN EXISTS (SELECT 1 FROM public.bookings b JOIN public.payments p ON p."bookingId" = b.id
                  WHERE (b."customerId" = p_customer OR p."payerCustomerId" = p_customer)
                    AND b.status IN ('cancelled', 'declined', 'expired') AND p.status = 'succeeded') THEN 'refund_may_be_due'
  END
$$;
REVOKE ALL ON FUNCTION public.privacy_active_trip_reason(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_active_trip_reason(uuid) TO mt_app, mt_privacy;

-- ---- Erasure functions, owned by mt_privacy (plan 0.1, 4.9) ----
-- Column grants only (review m3): the ids, links, statuses and dates the two functions read, never a personal column.
GRANT SELECT (id, "userId", "anonymisedAt") ON "customers" TO mt_privacy;
GRANT SELECT (id, "customerId", status, "returnDate") ON "bookings" TO mt_privacy;
GRANT SELECT (id, "bookingId", "payerCustomerId", status) ON "payments" TO mt_privacy;
GRANT SELECT (id, "customerId") ON "quotes", "complaints", "waitlist_entries" TO mt_privacy;
GRANT SELECT (id, "entityType", "entityId") ON "tasks" TO mt_privacy;

-- mt_privacy never reads users (0.3: it reaches nothing it does not need). The one fact privacy_erase_account needs, "this
-- is a customer sign-in account that is already anonymised", comes from this owner function, callable by mt_privacy only.
CREATE FUNCTION public.privacy_account_is_anonymised_customer(p_user uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.kind = 'customer' AND u."anonymisedAt" IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION public.privacy_account_is_anonymised_customer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_account_is_anonymised_customer(uuid) TO mt_privacy;

-- Same idea for complaints (review round 2): "these complaints are unlinked and already redacted", without mt_privacy
-- reading a complaint's text or address.
CREATE FUNCTION public.privacy_complaints_redacted(p_complaints uuid[]) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.complaints x WHERE x.id = ANY(p_complaints)
                       AND (x."customerId" IS NOT NULL OR x."complainantEmail" IS NOT NULL OR x."complainantName" <> '[redacted]'))
$$;
REVOKE ALL ON FUNCTION public.privacy_complaints_redacted(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_complaints_redacted(uuid[]) TO mt_privacy;
GRANT SELECT (id, "customerId") ON "consent_records" TO mt_privacy;
GRANT UPDATE ("customerId") ON "consent_records" TO mt_privacy;

-- The last step of erasing a customer, inside the API's transaction after every handler has run. Refuses a customer that
-- is not anonymised yet (so the API role cannot use it to purge a live customer's audit values) or that has an active
-- trip. Deletes the personal values of the audit log whose subject is the customer or its user, and the subject-less
-- values of audit rows about the customer's own records (itself, its bookings, quotes, complaints and waiting list
-- entries, and tasks on any of those, written before those links existed). Clears the customer from consent records.
CREATE FUNCTION public.privacy_erase_customer(p_customer uuid) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_erased timestamptz;
  v_reason text;
  deleted integer;
BEGIN
  SELECT c."userId", c."anonymisedAt" INTO v_user, v_erased FROM public.customers c WHERE c.id = p_customer;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'privacy_customer_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_erased IS NULL THEN
    RAISE EXCEPTION 'privacy_customer_not_anonymised' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_reason := public.privacy_active_trip_reason(p_customer);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'erasure_rejected_with_active_trip' USING ERRCODE = 'check_violation';
  END IF;

  WITH owned AS (
    SELECT 'Customer'::text AS t, p_customer AS id
    UNION ALL SELECT 'Booking', b.id FROM public.bookings b WHERE b."customerId" = p_customer
    UNION ALL SELECT 'Quote', q.id FROM public.quotes q WHERE q."customerId" = p_customer
    UNION ALL SELECT 'Complaint', x.id FROM public.complaints x WHERE x."customerId" = p_customer
    UNION ALL SELECT 'WaitlistEntry', w.id FROM public.waitlist_entries w WHERE w."customerId" = p_customer
  ), targets AS (
    SELECT o.t, o.id FROM owned o
    UNION ALL SELECT 'Task', k.id FROM public.tasks k JOIN owned o ON k."entityType" = o.t AND k."entityId" = o.id
  )
  DELETE FROM public.audit_pii_values v
   USING public.audit_logs l
   WHERE v."auditLogId" = l.id
     AND (v."subjectCustomerId" = p_customer
          OR (v_user IS NOT NULL AND v."subjectUserId" = v_user)
          OR (v."subjectCustomerId" IS NULL AND v."subjectUserId" IS NULL
              AND EXISTS (SELECT 1 FROM targets g WHERE g.t = l."entityType" AND g.id = l."entityId")));
  GET DIAGNOSTICS deleted = ROW_COUNT;

  UPDATE public.consent_records SET "customerId" = NULL WHERE "customerId" = p_customer;

  INSERT INTO public.audit_logs (id, "actorType", action, "entityType", "entityId", changes)
  VALUES (pg_catalog.gen_random_uuid(), 'system', 'privacy.customer.audit_values_erased', 'Customer', p_customer,
          pg_catalog.jsonb_build_object('deleted', deleted));
  RETURN deleted;
END;
$$;

-- Erasing a sign-in account that never became a customer (plan 5.5, section 2.1): its audit values, and (review round 2)
-- the subject-less values of the complaints logged with its address and no customer, and of tasks on them. The API
-- passes those complaint ids; each must be unlinked and already redacted (its address cleared by the complaints
-- handler in the same transaction), so the call cannot reach a live complaint's values.
CREATE FUNCTION public.privacy_erase_account(p_user uuid, p_complaints uuid[] DEFAULT '{}') RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted integer;
  more integer;
BEGIN
  IF NOT public.privacy_account_is_anonymised_customer(p_user) THEN
    RAISE EXCEPTION 'privacy_account_not_anonymised' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers c WHERE c."userId" = p_user) THEN
    RAISE EXCEPTION 'privacy_account_has_customer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.privacy_complaints_redacted(p_complaints) THEN
    RAISE EXCEPTION 'privacy_complaint_not_redacted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.audit_pii_values v WHERE v."subjectUserId" = p_user;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  WITH targets AS (
    SELECT 'Complaint'::text AS t, x.id FROM public.complaints x WHERE x.id = ANY(p_complaints)
    UNION ALL SELECT 'Task', k.id FROM public.tasks k WHERE k."entityType" = 'Complaint' AND k."entityId" = ANY(p_complaints)
  )
  DELETE FROM public.audit_pii_values v
   USING public.audit_logs l
   WHERE v."auditLogId" = l.id AND v."subjectCustomerId" IS NULL AND v."subjectUserId" IS NULL
     AND EXISTS (SELECT 1 FROM targets g WHERE g.t = l."entityType" AND g.id = l."entityId");
  GET DIAGNOSTICS more = ROW_COUNT;
  deleted := deleted + more;
  INSERT INTO public.audit_logs (id, "actorType", action, "entityType", "entityId", changes)
  VALUES (pg_catalog.gen_random_uuid(), 'system', 'privacy.account.audit_values_erased', 'User', p_user,
          pg_catalog.jsonb_build_object('deleted', deleted));
  RETURN deleted;
END;
$$;

-- Same hand-over as privacy_purge_expired (migration 0004): privileges first, then the owner.
REVOKE ALL ON FUNCTION public.privacy_erase_customer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.privacy_erase_account(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_erase_customer(uuid) TO mt_app;
GRANT EXECUTE ON FUNCTION public.privacy_erase_account(uuid, uuid[]) TO mt_app;
GRANT CREATE ON SCHEMA public TO mt_privacy;
ALTER FUNCTION public.privacy_erase_customer(uuid) OWNER TO mt_privacy;
ALTER FUNCTION public.privacy_erase_account(uuid, uuid[]) OWNER TO mt_privacy;
REVOKE CREATE ON SCHEMA public FROM mt_privacy;
REVOKE ALL ON FUNCTION public.mt_privacy_request_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mt_consent_record_guard() FROM PUBLIC;
