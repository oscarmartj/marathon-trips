-- Task 5.6: automatic balance reminders. No table: a reminder is one outbound email whose dedupe key names the plan item and
-- the offset, so the email table is the record that it was sent. This only adds the queue of the job that queues them.

-- Queue (pg-boss), as declared in src/platform/jobs/queues.ts.
SELECT pgboss.create_queue('payments.reminders', '{"policy":"short","retryLimit":0,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
