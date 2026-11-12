-- Task 7.4: automations. Rules (trigger, conditions, closed list of actions) and their run log.
-- Plan: docs/plans/7.4-automations.md. A rule never moves money or changes permissions (closed action list in code).

-- CreateEnum
CREATE TYPE "AutomationTriggerType" AS ENUM ('event', 'schedule');
CREATE TYPE "AutomationRunSource" AS ENUM ('event', 'schedule', 'manual');
CREATE TYPE "AutomationRunStatus" AS ENUM ('pending', 'succeeded', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "triggerType" "AutomationTriggerType" NOT NULL,
    "eventType" TEXT,
    "schedule" JSONB,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "enabledAt" TIMESTAMPTZ(3),
    "ownerUserId" UUID NOT NULL,
    "ownerKind" "UserKind" NOT NULL DEFAULT 'staff',
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "source" "AutomationRunSource" NOT NULL,
    "triggerEventId" UUID,
    "triggerEventType" TEXT,
    "scheduledFor" TIMESTAMPTZ(3),
    "entityType" TEXT,
    "entityId" UUID,
    "facts" JSONB,
    "testMode" BOOLEAN NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'pending',
    "reasonCode" TEXT,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_rules_triggerType_eventType_idx" ON "automation_rules"("triggerType", "eventType");
CREATE INDEX "automation_rules_ownerUserId_idx" ON "automation_rules"("ownerUserId");
CREATE INDEX "automation_runs_ruleId_startedAt_idx" ON "automation_runs"("ruleId", "startedAt");
CREATE INDEX "automation_runs_status_startedAt_idx" ON "automation_runs"("status", "startedAt");

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_ownerUserId_ownerKind_fkey" FOREIGN KEY ("ownerUserId", "ownerKind") REFERENCES "users"("id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Constraints and indexes that Prisma cannot express (it ignores them when it compares the schema with the migrations).
ALTER TABLE "automation_rules"
  ADD CONSTRAINT "automation_rules_owner_is_staff" CHECK ("ownerKind" = 'staff'),
  ADD CONSTRAINT "automation_rules_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "automation_rules_event_type_form" CHECK ("eventType" IS NULL OR "eventType" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  ADD CONSTRAINT "automation_rules_trigger_shape" CHECK (
    ("triggerType" = 'event' AND "eventType" IS NOT NULL AND "schedule" IS NULL)
    OR ("triggerType" = 'schedule' AND "eventType" IS NULL AND "schedule" IS NOT NULL)),
  ADD CONSTRAINT "automation_rules_lists_are_arrays" CHECK (jsonb_typeof("conditions") = 'array' AND jsonb_typeof("actions") = 'array'),
  ADD CONSTRAINT "automation_rules_enabled_shape" CHECK (NOT "enabled" OR ("enabledAt" IS NOT NULL AND "deletedAt" IS NULL)),
  ADD CONSTRAINT "automation_rules_deleted_together" CHECK (("deletedAt" IS NULL) = ("deletedById" IS NULL)),
  ADD CONSTRAINT "automation_rules_version_check" CHECK ("version" >= 0);

ALTER TABLE "automation_runs"
  ADD CONSTRAINT "automation_runs_source_shape" CHECK (
    ("source" = 'event' AND "triggerEventId" IS NOT NULL AND "triggerEventType" IS NOT NULL AND "scheduledFor" IS NULL)
    OR ("source" = 'schedule' AND "triggerEventId" IS NULL AND "scheduledFor" IS NOT NULL)
    OR ("source" = 'manual' AND "triggerEventId" IS NULL AND "scheduledFor" IS NULL)),
  -- A test from the panel can never act.
  ADD CONSTRAINT "automation_runs_manual_is_test" CHECK ("source" <> 'manual' OR "testMode"),
  ADD CONSTRAINT "automation_runs_entity_together" CHECK (("entityType" IS NULL) = ("entityId" IS NULL)),
  ADD CONSTRAINT "automation_runs_entity_type_form" CHECK ("entityType" IS NULL OR "entityType" ~ '^[A-Z][A-Za-z]{0,63}$'),
  ADD CONSTRAINT "automation_runs_steps_array" CHECK (jsonb_typeof("steps") = 'array'),
  ADD CONSTRAINT "automation_runs_facts_object" CHECK ("facts" IS NULL OR jsonb_typeof("facts") = 'object'),
  ADD CONSTRAINT "automation_runs_attempts_check" CHECK ("attempts" BETWEEN 0 AND 10),
  ADD CONSTRAINT "automation_runs_finished_shape" CHECK (("status" = 'pending') = ("finishedAt" IS NULL)),
  ADD CONSTRAINT "automation_runs_reason_code" CHECK ("reasonCode" IS NULL OR "reasonCode" IN (
    'conditions_not_met', 'event_too_old', 'module_disabled', 'rule_disabled', 'rule_changed', 'rule_invalid', 'owner_inactive',
    'automation_cannot_exceed_author_permissions', 'entity_gone', 'rate_limited', 'stale', 'action_failed', 'transient_error')),
  ADD CONSTRAINT "automation_runs_reason_shape" CHECK ("status" NOT IN ('skipped', 'failed') OR "reasonCode" IS NOT NULL);

-- One run per rule and event, or per rule and scheduled time, also across API instances. Panel tests are not limited.
CREATE UNIQUE INDEX "automation_runs_once" ON "automation_runs"("ruleId", "triggerEventId", "scheduledFor") NULLS NOT DISTINCT WHERE "source" <> 'manual';
-- The consumer finds the enabled rules of an event type.
CREATE INDEX "automation_rules_enabled_event" ON "automation_rules"("eventType") WHERE "enabled";

-- Rules are never deleted, only marked deleted (runs point at them). Runs are purged after 90 days by the API.
REVOKE DELETE, TRUNCATE ON "automation_rules" FROM mt_app;
REVOKE TRUNCATE ON "automation_runs" FROM mt_app;

-- Queues (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('automations.run', '{"policy":"short","retryLimit":3,"retryDelay":30,"retryBackoff":true,"expireInSeconds":300,"deleteAfterSeconds":604800}'::jsonb);
SELECT pgboss.create_queue('automations.tick', '{"policy":"short","retryLimit":0,"retryDelay":60,"expireInSeconds":120,"deleteAfterSeconds":604800}'::jsonb);
SELECT pgboss.create_queue('automations.maintenance', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
