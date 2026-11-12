-- Task 7.6: complaints register. A complaint is never deleted; deadlines are calendar dates; no amounts are stored.

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('received', 'acknowledged', 'investigating', 'resolved', 'closed', 'withdrawn');
CREATE TYPE "ComplaintCategory" AS ENUM ('service', 'pricing', 'accommodation', 'transport', 'race_entry', 'communication', 'payment', 'other');
CREATE TYPE "ComplaintChannel" AS ENUM ('email', 'phone', 'web', 'in_person', 'post', 'other');
CREATE TYPE "ComplaintOutcome" AS ENUM ('upheld', 'partly_upheld', 'not_upheld', 'no_finding');

-- CreateTable
CREATE TABLE "complaints" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "customerId" UUID,
    "bookingId" UUID,
    "complainantName" TEXT NOT NULL,
    "complainantEmail" TEXT,
    "channel" "ComplaintChannel" NOT NULL,
    "category" "ComplaintCategory" NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "receivedDate" DATE NOT NULL,
    "acknowledgeDueDate" DATE NOT NULL,
    "resolveDueDate" DATE NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(3),
    "ownerId" UUID,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'received',
    "outcome" "ComplaintOutcome",
    "resolutionSummary" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "withdrawnAt" TIMESTAMPTZ(3),
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "complaints_reference_key" ON "complaints"("reference");
CREATE INDEX "complaints_status_resolveDueDate_idx" ON "complaints"("status", "resolveDueDate");
CREATE INDEX "complaints_status_acknowledgeDueDate_idx" ON "complaints"("status", "acknowledgeDueDate");
CREATE INDEX "complaints_customerId_idx" ON "complaints"("customerId");
CREATE INDEX "complaints_bookingId_idx" ON "complaints"("bookingId");
CREATE INDEX "complaints_ownerId_status_idx" ON "complaints"("ownerId", "status");

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Rules the database enforces as a backstop (the API checks them first).
ALTER TABLE "complaints"
  ADD CONSTRAINT "complaints_reference_form" CHECK ("reference" ~ '^CP-[0-9A-HJKMNP-TV-Z]{6}$'),
  ADD CONSTRAINT "complaints_text_lengths" CHECK (
    length(btrim("complainantName")) BETWEEN 1 AND 200 AND length(btrim("summary")) BETWEEN 1 AND 200 AND length(btrim("description")) BETWEEN 1 AND 4000
    AND ("complainantEmail" IS NULL OR length("complainantEmail") <= 254) AND ("resolutionSummary" IS NULL OR length("resolutionSummary") <= 4000)
  ),
  -- Both deadlines count from the day the complaint arrived, and acknowledging comes first.
  ADD CONSTRAINT "complaints_deadlines_in_order" CHECK ("receivedDate" <= "acknowledgeDueDate" AND "acknowledgeDueDate" <= "resolveDueDate"),
  -- A resolved or closed complaint always carries its outcome, its written resolution and when it was resolved.
  ADD CONSTRAINT "complaints_resolution_complete" CHECK (
    "status" NOT IN ('resolved', 'closed')
    OR ("outcome" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "resolutionSummary" IS NOT NULL AND length(btrim("resolutionSummary")) > 0)
  ),
  -- Only a resolved or closed complaint has a resolution; reopening clears it (the audit log keeps the earlier one).
  ADD CONSTRAINT "complaints_resolution_only_when_resolved" CHECK (
    "status" IN ('resolved', 'closed') OR ("outcome" IS NULL AND "resolvedAt" IS NULL AND "resolutionSummary" IS NULL)
  ),
  -- Acknowledged once it has left `received`, unless it was withdrawn unanswered.
  ADD CONSTRAINT "complaints_acknowledged_when_past_received" CHECK ("status" IN ('received', 'withdrawn') OR "acknowledgedAt" IS NOT NULL),
  ADD CONSTRAINT "complaints_closed_at_matches" CHECK (("status" = 'closed') = ("closedAt" IS NOT NULL)),
  ADD CONSTRAINT "complaints_withdrawn_at_matches" CHECK (("status" = 'withdrawn') = ("withdrawnAt" IS NOT NULL));
