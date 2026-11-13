-- Task 7.7: funnel per race and report builder. Anonymous daily counters, saved reports with an optional schedule, and
-- one row per scheduled run. No personal data and no money.

-- CreateEnum
CREATE TYPE "ReportEntity" AS ENUM ('funnel', 'bookings');
CREATE TYPE "ReportRunStatus" AS ENUM ('queued', 'skipped');

-- CreateTable
CREATE TABLE "race_daily_stats" (
    "raceId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "builderUses" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "race_daily_stats_pkey" PRIMARY KEY ("raceId","day")
);

CREATE TABLE "saved_reports" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "entity" "ReportEntity" NOT NULL,
    "definition" JSONB NOT NULL,
    "schedule" JSONB,
    "recipientUserIds" UUID[],
    "ownerUserId" UUID NOT NULL,
    "ownerKind" "UserKind" NOT NULL DEFAULT 'staff',
    "scheduleStartedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "report_runs" (
    "id" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "status" "ReportRunStatus" NOT NULL,
    "reasonCode" TEXT,
    "emailsQueued" INTEGER NOT NULL DEFAULT 0,
    "recipientsSkipped" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_reports_ownerUserId_idx" ON "saved_reports"("ownerUserId");
CREATE UNIQUE INDEX "report_runs_reportId_scheduledFor_key" ON "report_runs"("reportId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "race_daily_stats" ADD CONSTRAINT "race_daily_stats_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_ownerUserId_ownerKind_fkey" FOREIGN KEY ("ownerUserId", "ownerKind") REFERENCES "users"("id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "saved_reports"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints that Prisma cannot express.
ALTER TABLE "race_daily_stats"
  ADD CONSTRAINT "race_daily_stats_counts_check" CHECK ("views" >= 0 AND "builderUses" >= 0);
ALTER TABLE "saved_reports"
  ADD CONSTRAINT "saved_reports_owner_is_staff" CHECK ("ownerKind" = 'staff'),
  ADD CONSTRAINT "saved_reports_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "saved_reports_definition_object" CHECK (jsonb_typeof("definition") = 'object'),
  ADD CONSTRAINT "saved_reports_schedule_object" CHECK ("schedule" IS NULL OR jsonb_typeof("schedule") = 'object'),
  ADD CONSTRAINT "saved_reports_schedule_started" CHECK (("schedule" IS NULL) OR ("scheduleStartedAt" IS NOT NULL)),
  ADD CONSTRAINT "saved_reports_recipients_cap" CHECK (cardinality("recipientUserIds") <= 20),
  ADD CONSTRAINT "saved_reports_deleted_together" CHECK (("deletedAt" IS NULL) = ("deletedById" IS NULL)),
  ADD CONSTRAINT "saved_reports_version_check" CHECK ("version" >= 0);
ALTER TABLE "report_runs"
  ADD CONSTRAINT "report_runs_counts_check" CHECK ("emailsQueued" >= 0 AND "recipientsSkipped" >= 0),
  ADD CONSTRAINT "report_runs_reason_shape" CHECK (("status" = 'skipped') = ("reasonCode" IS NOT NULL)),
  ADD CONSTRAINT "report_runs_reason_code" CHECK ("reasonCode" IS NULL OR "reasonCode" IN ('owner_unavailable', 'no_recipients', 'report_invalid', 'module_disabled'));

-- Reports are never deleted, only marked (runs point at them); counters and runs are never deleted by the API.
REVOKE DELETE, TRUNCATE ON "saved_reports" FROM mt_app;
-- A run is written once and never changed.
REVOKE UPDATE, DELETE, TRUNCATE ON "report_runs" FROM mt_app;
REVOKE DELETE, TRUNCATE ON "race_daily_stats" FROM mt_app;

-- Queue (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('reports.tick', '{"policy":"short","retryLimit":0,"retryDelay":60,"expireInSeconds":300,"deleteAfterSeconds":604800}'::jsonb);
