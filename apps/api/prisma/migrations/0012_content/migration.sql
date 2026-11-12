-- Task 8.1: content manager (media library, pages, race guides, FAQs, banners, menu items and redirects).

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('draft', 'published');
CREATE TYPE "PageKind" AS ENUM ('general', 'legal');
CREATE TYPE "BannerTone" AS ENUM ('info', 'notice', 'warning');
CREATE TYPE "MenuLocation" AS ENUM ('header', 'footer_company', 'footer_legal');

-- CreateTable
CREATE TABLE "content_media" (
    "id" UUID NOT NULL,
    "src" TEXT NOT NULL,
    "altText" TEXT NOT NULL DEFAULT '',
    "decorative" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "credit" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "content_media_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_pages" (
    "id" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-AU',
    "slug" TEXT NOT NULL,
    "kind" "PageKind" NOT NULL DEFAULT 'general',
    "title" TEXT NOT NULL,
    "intro" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMPTZ(3),
    "seoTitle" TEXT NOT NULL DEFAULT '',
    "seoDescription" TEXT NOT NULL DEFAULT '',
    "legalReviewPending" BOOLEAN NOT NULL DEFAULT false,
    "heroMediaId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "content_pages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_guides" (
    "id" UUID NOT NULL,
    "raceId" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-AU',
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMPTZ(3),
    "course" TEXT NOT NULL DEFAULT '',
    "climate" TEXT NOT NULL DEFAULT '',
    "entry" TEXT NOT NULL DEFAULT '',
    "travelTips" TEXT NOT NULL DEFAULT '',
    "seoTitle" TEXT NOT NULL DEFAULT '',
    "seoDescription" TEXT NOT NULL DEFAULT '',
    "heroMediaId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "content_guides_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_faqs" (
    "id" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-AU',
    "category" TEXT NOT NULL DEFAULT '',
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "content_faqs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_banners" (
    "id" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-AU',
    "message" TEXT NOT NULL,
    "linkLabel" TEXT NOT NULL DEFAULT '',
    "linkHref" TEXT NOT NULL DEFAULT '',
    "tone" "BannerTone" NOT NULL DEFAULT 'info',
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "content_banners_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_menu_items" (
    "id" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en-AU',
    "location" "MenuLocation" NOT NULL,
    "label" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "content_menu_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "content_redirects" (
    "id" UUID NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "content_redirects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_pages_locale_slug_key" ON "content_pages"("locale", "slug");
CREATE INDEX "content_pages_status_idx" ON "content_pages"("status");
CREATE UNIQUE INDEX "content_guides_raceId_locale_key" ON "content_guides"("raceId", "locale");
CREATE INDEX "content_guides_status_idx" ON "content_guides"("status");
CREATE INDEX "content_faqs_locale_status_sortOrder_idx" ON "content_faqs"("locale", "status", "sortOrder");
CREATE INDEX "content_banners_locale_status_idx" ON "content_banners"("locale", "status");
CREATE INDEX "content_menu_items_locale_location_status_sortOrder_idx" ON "content_menu_items"("locale", "location", "status", "sortOrder");
CREATE UNIQUE INDEX "content_redirects_fromPath_key" ON "content_redirects"("fromPath");

-- AddForeignKey
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_heroMediaId_fkey" FOREIGN KEY ("heroMediaId") REFERENCES "content_media"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_guides" ADD CONSTRAINT "content_guides_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "content_guides" ADD CONSTRAINT "content_guides_heroMediaId_fkey" FOREIGN KEY ("heroMediaId") REFERENCES "content_media"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Business rules the database enforces as a backstop (the API checks them first).
ALTER TABLE "content_media" ADD CONSTRAINT "content_media_src_form" CHECK ("src" ~ '^(https://[^[:space:]]+|/[A-Za-z0-9._~/-]+)$' AND "src" !~ '^//');
ALTER TABLE "content_media" ADD CONSTRAINT "content_media_alt_text" CHECK (("decorative" AND "altText" = '') OR (NOT "decorative" AND length(btrim("altText")) > 0));
ALTER TABLE "content_media" ADD CONSTRAINT "content_media_size" CHECK (("width" IS NULL OR "width" BETWEEN 1 AND 20000) AND ("height" IS NULL OR "height" BETWEEN 1 AND 20000));
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_locale_form" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_slug_form" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_published_at" CHECK (("status" = 'published') = ("publishedAt" IS NOT NULL));
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_legal_review_only_legal" CHECK ("kind" = 'legal' OR NOT "legalReviewPending");
ALTER TABLE "content_guides" ADD CONSTRAINT "content_guides_locale_form" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
ALTER TABLE "content_guides" ADD CONSTRAINT "content_guides_published_at" CHECK (("status" = 'published') = ("publishedAt" IS NOT NULL));
ALTER TABLE "content_faqs" ADD CONSTRAINT "content_faqs_locale_form" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
ALTER TABLE "content_banners" ADD CONSTRAINT "content_banners_locale_form" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
ALTER TABLE "content_banners" ADD CONSTRAINT "content_banners_window" CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "startsAt" < "endsAt");
ALTER TABLE "content_banners" ADD CONSTRAINT "content_banners_link" CHECK (("linkHref" = '') = ("linkLabel" = ''));
ALTER TABLE "content_banners" ADD CONSTRAINT "content_banners_href_form" CHECK ("linkHref" = '' OR "linkHref" ~ '^(https://[^[:space:]]+|/[^[:space:]/][^[:space:]]*|/)$');
ALTER TABLE "content_menu_items" ADD CONSTRAINT "content_menu_items_locale_form" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
ALTER TABLE "content_menu_items" ADD CONSTRAINT "content_menu_items_href_form" CHECK ("href" ~ '^(https://[^[:space:]]+|/[^[:space:]/][^[:space:]]*|/)$');
ALTER TABLE "content_redirects" ADD CONSTRAINT "content_redirects_from_form" CHECK ("fromPath" ~ '^/[^[:space:]?#]+$' AND "fromPath" !~ '^//');
ALTER TABLE "content_redirects" ADD CONSTRAINT "content_redirects_to_form" CHECK ("toPath" ~ '^(https://[^[:space:]]+|/[^[:space:]/][^[:space:]]*|/)$');
ALTER TABLE "content_redirects" ADD CONSTRAINT "content_redirects_status_code" CHECK ("statusCode" IN (301, 302, 307, 308));
ALTER TABLE "content_redirects" ADD CONSTRAINT "content_redirects_not_self" CHECK ("fromPath" <> "toPath");
