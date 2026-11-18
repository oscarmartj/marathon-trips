-- Task 7.fix-2 (plan docs/plans/7.fix-2-automations.md): fixes from the post-merge review of 7.4.

-- Section 1: the service-message acknowledgement of a rule's customer notices.
ALTER TABLE "automation_rules" ADD COLUMN "serviceNoticeAckAt" TIMESTAMPTZ(3);

-- Section 4: a backlog is processed oldest first, by when its event happened.
ALTER TABLE "automation_runs" ADD COLUMN "eventOccurredAt" TIMESTAMPTZ(3);
CREATE INDEX "automation_runs_pending_order" ON "automation_runs"("ruleId", "eventOccurredAt") WHERE "status" = 'pending';

-- Section 1: the per-customer cap counts a customer's recent emails under a lock; without this it scanned the table.
CREATE INDEX "outbound_emails_customerId_createdAt_idx" ON "outbound_emails"("customerId", "createdAt");
