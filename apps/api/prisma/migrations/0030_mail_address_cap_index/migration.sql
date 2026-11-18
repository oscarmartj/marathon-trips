-- Task 8.5 (S-07): the per-address cap on sign-in and confirmation emails is counted in the database.
CREATE INDEX "outbound_emails_to_templateKey_createdAt_idx" ON "outbound_emails"("to", "templateKey", "createdAt");
