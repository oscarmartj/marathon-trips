-- Task 7.3: key dates calendar. Stored dates per edition (entry submission deadline, custom dates) and the queue of the
-- job that opens tasks for dates that are coming up. Release dates and balance due dates are read from their own tables.

-- CreateEnum
CREATE TYPE "KeyDateKind" AS ENUM ('entry_submission', 'custom');

-- CreateTable
CREATE TABLE "key_dates" (
    "id" UUID NOT NULL,
    "editionId" UUID NOT NULL,
    "kind" "KeyDateKind" NOT NULL,
    "label" TEXT,
    "dueDate" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "key_dates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_dates_editionId_dueDate_idx" ON "key_dates"("editionId", "dueDate");

-- AddForeignKey
ALTER TABLE "key_dates" ADD CONSTRAINT "key_dates_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints that Prisma cannot express.
ALTER TABLE "key_dates"
  ADD CONSTRAINT "key_dates_label_length" CHECK ("label" IS NULL OR char_length(btrim("label")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "key_dates_custom_has_label" CHECK ("kind" <> 'custom' OR "label" IS NOT NULL),
  ADD CONSTRAINT "key_dates_version_check" CHECK ("version" >= 0);
-- One entry submission deadline per edition.
CREATE UNIQUE INDEX "key_dates_one_entry_submission" ON "key_dates"("editionId") WHERE "kind" = 'entry_submission';

-- Queue (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('keydates.maintenance', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
