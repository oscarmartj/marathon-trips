-- Task 0.5: shared capabilities of panel tables (docs/plans/0.5-table-capabilities.md).

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('manual', 'automation', 'system');

-- CreateEnum
CREATE TYPE "CsvJobKind" AS ENUM ('import', 'export');

-- CreateEnum
CREATE TYPE "CsvJobStatus" AS ENUM ('previewed', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "BulkOperationStatus" AS ENUM ('completed', 'partial', 'failed');

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "name" CITEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "entityTypes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "taggings" (
    "id" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "taggings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT,
    "entityId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "assigneeId" UUID,
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "source" "TaskSource" NOT NULL DEFAULT 'manual',
    "sourceRef" TEXT,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "sort" JSONB NOT NULL DEFAULT '[]',
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_documents" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "searchVector" tsvector,
    "permissionKey" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "search_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "csv_jobs" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "kind" "CsvJobKind" NOT NULL,
    "status" "CsvJobStatus" NOT NULL,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "csv_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_operations" (
    "id" UUID NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityIds" UUID[],
    "status" "BulkOperationStatus" NOT NULL,
    "results" JSONB NOT NULL DEFAULT '[]',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "taggings_entityType_entityId_idx" ON "taggings"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "taggings_tagId_entityType_entityId_key" ON "taggings"("tagId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "notes_entityType_entityId_deletedAt_idx" ON "notes"("entityType", "entityId", "deletedAt");

-- CreateIndex
CREATE INDEX "tasks_status_dueAt_idx" ON "tasks"("status", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_deletedAt_idx" ON "tasks"("deletedAt");

-- CreateIndex
CREATE INDEX "saved_views_entityType_shared_idx" ON "saved_views"("entityType", "shared");

-- CreateIndex
CREATE UNIQUE INDEX "saved_views_ownerId_entityType_name_key" ON "saved_views"("ownerId", "entityType", "name");

-- CreateIndex
CREATE INDEX "search_documents_searchVector_idx" ON "search_documents" USING GIN ("searchVector");

-- CreateIndex
CREATE UNIQUE INDEX "search_documents_entityType_entityId_key" ON "search_documents"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "csv_jobs_createdAt_idx" ON "csv_jobs"("createdAt");

-- AddForeignKey
ALTER TABLE "taggings" ADD CONSTRAINT "taggings_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Checks and triggers Prisma cannot express.
ALTER TABLE "tags" ADD CONSTRAINT "tags_colour_hex" CHECK ("colour" ~ '^#[0-9a-f]{6}$');
ALTER TABLE "notes" ADD CONSTRAINT "notes_body_length" CHECK (char_length("body") BETWEEN 1 AND 5000);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_target_pair" CHECK (("entityType" IS NULL) = ("entityId" IS NULL));
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_name_length" CHECK (char_length("name") BETWEEN 1 AND 80);

-- The search vector always follows title and subtitle ('simple' configuration: names are not stemmed).
CREATE FUNCTION public.mt_search_documents_vector() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple'::regconfig, coalesce(NEW."title", '') || ' ' || coalesce(NEW."subtitle", ''));
  RETURN NEW;
END;
$$;

CREATE TRIGGER search_documents_vector BEFORE INSERT OR UPDATE ON "search_documents"
  FOR EACH ROW EXECUTE FUNCTION public.mt_search_documents_vector();
