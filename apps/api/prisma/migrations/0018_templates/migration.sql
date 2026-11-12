-- Task 5.4: editable email and document templates. Wording only, with {{variable}} placeholders; no customer data.

-- CreateEnum
CREATE TYPE "TemplateChannel" AS ENUM ('email', 'document');
CREATE TYPE "TemplateStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "channel" "TemplateChannel" NOT NULL,
    "key" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-AU',
    "revision" INTEGER NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'draft',
    "subject" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_channel_key_locale_revision_key" ON "message_templates"("channel", "key", "locale", "revision");
CREATE INDEX "message_templates_channel_key_locale_status_idx" ON "message_templates"("channel", "key", "locale", "status");

-- Constraints and indexes that Prisma cannot express (it ignores them when it compares the schema with the migrations).
ALTER TABLE "message_templates"
  ADD CONSTRAINT "message_templates_locale_form" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  ADD CONSTRAINT "message_templates_key_form" CHECK ("key" ~ '^[a-z][a-z0-9_.]{0,63}$'),
  ADD CONSTRAINT "message_templates_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "message_templates_body_check" CHECK (length(btrim("body")) > 0 AND length("body") <= 20000),
  ADD CONSTRAINT "message_templates_subject_check" CHECK (length("subject") <= 300 AND "subject" !~ '[\r\n]' AND ("channel" = 'document' OR length(btrim("subject")) > 0));

-- At most one live revision per template and language.
CREATE UNIQUE INDEX "message_templates_one_active" ON "message_templates"("channel", "key", "locale") WHERE "status" = 'active';
