-- Task 2.5: quotes (priced configurations staff prepare for a customer and hold until they expire).
-- Plan docs/plans/2.5-booking-crm.md. No money moves here.

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'sent', 'accepted', 'expired', 'withdrawn');

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "editionId" UUID NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "configuration" JSONB NOT NULL,
    "priceBreakdown" JSONB NOT NULL,
    "totalMinor" BIGINT NOT NULL,
    "depositMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "priceVersionId" UUID NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "departureDate" DATE NOT NULL,
    "returnDate" DATE NOT NULL,
    "balanceDueDate" DATE NOT NULL,
    "validForDays" INTEGER NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "acceptedAt" TIMESTAMPTZ(3),
    "expiredAt" TIMESTAMPTZ(3),
    "withdrawnAt" TIMESTAMPTZ(3),
    "bookingId" UUID,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotes_reference_key" ON "quotes"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_bookingId_key" ON "quotes"("bookingId");

-- CreateIndex
CREATE INDEX "quotes_customerId_status_idx" ON "quotes"("customerId", "status");

-- CreateIndex
CREATE INDEX "quotes_status_expiresAt_idx" ON "quotes"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_bookingId_currency_key" ON "quotes"("bookingId", "currency");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_packageId_currency_fkey" FOREIGN KEY ("packageId", "currency") REFERENCES "packages"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_priceVersionId_currency_fkey" FOREIGN KEY ("priceVersionId", "currency") REFERENCES "price_versions"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_bookingId_currency_fkey" FOREIGN KEY ("bookingId", "currency") REFERENCES "bookings"("id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---- Rules the database keeps whatever the code does ----
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_amounts_check" CHECK ("totalMinor" >= 0 AND "depositMinor" >= 0 AND "depositMinor" <= "totalMinor"),
  ADD CONSTRAINT "quotes_reference_check" CHECK ("reference" ~ '^QT-[0-9A-HJKMNP-TV-Z]{6}$'),
  ADD CONSTRAINT "quotes_dates_check" CHECK ("returnDate" >= "departureDate"),
  ADD CONSTRAINT "quotes_valid_days_check" CHECK ("validForDays" BETWEEN 1 AND 60),
  -- A quote that was sent has an expiry; an accepted one has its booking, and only an accepted one.
  ADD CONSTRAINT "quotes_state_check" CHECK (
    ("status" NOT IN ('sent', 'accepted', 'expired') OR ("expiresAt" IS NOT NULL AND "sentAt" IS NOT NULL))
    AND ("status" <> 'accepted' OR "acceptedAt" IS NOT NULL)
    AND ("status" <> 'expired' OR "expiredAt" IS NOT NULL)
    AND ("status" <> 'withdrawn' OR "withdrawnAt" IS NOT NULL)
    AND (("status" = 'accepted') = ("bookingId" IS NOT NULL))
  );

-- What the customer was offered never changes (the price is honoured until it expires): identity, configuration and
-- price are fixed at creation. The status only moves draft -> sent | withdrawn and sent -> accepted | expired |
-- withdrawn, every change bumps the version, the booking is set once on acceptance, and a quote is never deleted.
CREATE FUNCTION public.mt_quote_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a quote is never deleted; withdraw it' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'draft' OR NEW."bookingId" IS NOT NULL THEN
      RAISE EXCEPTION 'a quote starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.packages p WHERE p."id" = NEW."packageId" AND p."editionId" = NEW."editionId") THEN
      RAISE EXCEPTION 'a quote''s edition is its package''s edition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."reference" IS DISTINCT FROM OLD."reference" OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."packageId" IS DISTINCT FROM OLD."packageId" OR NEW."editionId" IS DISTINCT FROM OLD."editionId"
     OR NEW."configuration" IS DISTINCT FROM OLD."configuration" OR NEW."priceBreakdown" IS DISTINCT FROM OLD."priceBreakdown"
     OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor" OR NEW."depositMinor" IS DISTINCT FROM OLD."depositMinor"
     OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."priceVersionId" IS DISTINCT FROM OLD."priceVersionId"
     OR NEW."engineVersion" IS DISTINCT FROM OLD."engineVersion" OR NEW."departureDate" IS DISTINCT FROM OLD."departureDate"
     OR NEW."returnDate" IS DISTINCT FROM OLD."returnDate" OR NEW."balanceDueDate" IS DISTINCT FROM OLD."balanceDueDate"
     OR NEW."validForDays" IS DISTINCT FROM OLD."validForDays" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'what a quote offers never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."bookingId" IS NOT NULL AND NEW."bookingId" IS DISTINCT FROM OLD."bookingId" THEN
    RAISE EXCEPTION 'the booking of a quote never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."expiresAt" IS NOT NULL AND NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
    RAISE EXCEPTION 'the expiry of a sent quote never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."bookingId" IS DISTINCT FROM OLD."bookingId" AND NEW."status" <> 'accepted' THEN
    RAISE EXCEPTION 'a quote gets its booking only when it is accepted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT ((OLD."status", NEW."status") IN (
      ('draft'::"QuoteStatus", 'sent'::"QuoteStatus"), ('draft', 'withdrawn'),
      ('sent', 'accepted'), ('sent', 'expired'), ('sent', 'withdrawn')
    )) THEN
      RAISE EXCEPTION 'quote status cannot go from % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."version" <= OLD."version" THEN
      RAISE EXCEPTION 'a change of quote status bumps its version' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quotes_guard BEFORE INSERT OR UPDATE OR DELETE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION public.mt_quote_guard();
CREATE TRIGGER quotes_no_truncate BEFORE TRUNCATE ON "quotes"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Queues (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('crm.maintenance', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
