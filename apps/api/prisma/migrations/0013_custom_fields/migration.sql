-- Task 7.5: custom fields defined from the panel.

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('text', 'number', 'date', 'boolean', 'select', 'multiselect');

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" JSONB NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" JSONB,
    "validation" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "visibleToCustomer" BOOLEAN NOT NULL DEFAULT false,
    "editableByCustomer" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_entityType_key_key" ON "custom_field_definitions"("entityType", "key");
CREATE INDEX "custom_field_definitions_list_idx" ON "custom_field_definitions"("entityType", "archivedAt", "displayOrder");

-- Shape rules the application also checks.
ALTER TABLE "custom_field_definitions"
  ADD CONSTRAINT "custom_field_definitions_key_format" CHECK ("key" ~ '^(?!constructor$)[a-z][a-z0-9_]{0,39}$'),
  ADD CONSTRAINT "custom_field_definitions_customer_edit_needs_visible" CHECK (NOT "editableByCustomer" OR "visibleToCustomer"),
  ADD CONSTRAINT "custom_field_definitions_options_only_for_select" CHECK (
    ("type" IN ('select', 'multiselect') AND "options" IS NOT NULL AND jsonb_typeof("options") = 'array' AND jsonb_array_length("options") > 0)
    OR ("type" NOT IN ('select', 'multiselect') AND "options" IS NULL)
  );

-- A definition is never deleted (archive it) and its entity type, key and type never change, so a stored value always
-- keeps the meaning it was written with.
CREATE FUNCTION public.mt_custom_field_definition_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'a custom field definition cannot be deleted; archive it' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."entityType" IS DISTINCT FROM OLD."entityType" OR NEW."key" IS DISTINCT FROM OLD."key" OR NEW."type" IS DISTINCT FROM OLD."type" THEN
    RAISE EXCEPTION 'entityType, key and type of a custom field cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER custom_field_definitions_guard BEFORE UPDATE OR DELETE ON "custom_field_definitions"
  FOR EACH ROW EXECUTE FUNCTION public.mt_custom_field_definition_guard();
-- Like the append-only tables in 0004: TRUNCATE is refused too (a TRUNCATE trigger fires per statement, not per row).
CREATE TRIGGER custom_field_definitions_no_truncate BEFORE TRUNCATE ON "custom_field_definitions"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_custom_field_definition_guard();
