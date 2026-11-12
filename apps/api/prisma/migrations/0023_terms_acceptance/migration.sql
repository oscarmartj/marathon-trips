-- Task 3.5: the booking terms a customer accepted before paying, kept as a snapshot (the content page is edited in place).
-- Immutable: UPDATE, DELETE and TRUNCATE are rejected for every role (the same function as the append-only tables).

-- CreateTable
CREATE TABLE "terms_acceptances" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "documentSlug" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "contentVersion" INTEGER NOT NULL,
    "textDigest" CHAR(64) NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "terms_acceptances_bookingId_documentSlug_locale_textDigest_key" ON "terms_acceptances"("bookingId", "documentSlug", "locale", "textDigest");

-- AddForeignKey
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints that Prisma cannot express.
ALTER TABLE "terms_acceptances"
  ADD CONSTRAINT "terms_acceptances_version_check" CHECK ("contentVersion" >= 0),
  ADD CONSTRAINT "terms_acceptances_digest_check" CHECK ("textDigest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "terms_acceptances_text_not_empty" CHECK (char_length(btrim("title")) > 0);

CREATE TRIGGER terms_acceptances_immutable BEFORE UPDATE OR DELETE ON "terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER terms_acceptances_no_truncate BEFORE TRUNCATE ON "terms_acceptances"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
