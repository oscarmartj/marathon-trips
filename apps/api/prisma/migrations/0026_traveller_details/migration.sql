-- Task 5.2: traveller details (plan docs/plans/5.2-traveller-details.md). One row per place of a booking with the
-- minimum data an entry and a safe trip need: no passport or ID number, no medical or dietary data, no free text.

-- CreateTable
CREATE TABLE "travellers" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "slot" INTEGER NOT NULL,
    "givenName" TEXT NOT NULL,
    "familyName" TEXT NOT NULL,
    "dateOfBirth" DATE,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "estimatedFinishSeconds" INTEGER,
    "anonymisedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "travellers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "travellers_bookingId_slot_key" ON "travellers"("bookingId", "slot");
CREATE UNIQUE INDEX "travellers_id_customerId_key" ON "travellers"("id", "customerId");
CREATE INDEX "travellers_customerId_idx" ON "travellers"("customerId");

-- AddForeignKey
-- (bookingId, customerId): the details belong to the booking's own customer. (bookingId, slot): they describe a place of that booking.
ALTER TABLE "travellers" ADD CONSTRAINT "travellers_bookingId_customerId_fkey" FOREIGN KEY ("bookingId", "customerId") REFERENCES "bookings"("id", "customerId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "travellers" ADD CONSTRAINT "travellers_bookingId_slot_fkey" FOREIGN KEY ("bookingId", "slot") REFERENCES "booking_travellers"("bookingId", "slot") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints that Prisma cannot express.
-- Sizes and ranges (the API validates the same limits and the character sets; the database keeps the bounds). An erased
-- row holds no personal data at all.
ALTER TABLE "travellers"
  ADD CONSTRAINT "travellers_slot_check" CHECK ("slot" >= 1),
  ADD CONSTRAINT "travellers_names_check" CHECK (
    char_length(btrim("givenName")) BETWEEN 1 AND 100 AND char_length(btrim("familyName")) BETWEEN 1 AND 100),
  ADD CONSTRAINT "travellers_birth_check" CHECK ("dateOfBirth" IS NULL OR "dateOfBirth" >= DATE '1900-01-01'),
  ADD CONSTRAINT "travellers_emergency_check" CHECK (
    ("emergencyContactName" IS NULL) = ("emergencyContactPhone" IS NULL)
    AND ("emergencyContactName" IS NULL OR char_length(btrim("emergencyContactName")) BETWEEN 1 AND 100)
    AND ("emergencyContactPhone" IS NULL OR char_length("emergencyContactPhone") BETWEEN 6 AND 20)),
  ADD CONSTRAINT "travellers_finish_check" CHECK ("estimatedFinishSeconds" IS NULL OR "estimatedFinishSeconds" BETWEEN 600 AND 259200),
  ADD CONSTRAINT "travellers_erased_check" CHECK (
    "anonymisedAt" IS NULL OR ("givenName" = '[redacted]' AND "familyName" = '[redacted]' AND "dateOfBirth" IS NULL
      AND "emergencyContactName" IS NULL AND "emergencyContactPhone" IS NULL AND "estimatedFinishSeconds" IS NULL));

-- The place, the booking and the customer of a row never change; only the details do.
CREATE FUNCTION public.mt_traveller_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."bookingId" IS DISTINCT FROM OLD."bookingId"
     OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."slot" IS DISTINCT FROM OLD."slot"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'the place of a traveller never changes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER travellers_guard BEFORE UPDATE ON "travellers"
  FOR EACH ROW EXECUTE FUNCTION public.mt_traveller_guard();
