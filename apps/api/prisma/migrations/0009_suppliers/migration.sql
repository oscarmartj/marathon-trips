-- Task 6.1: suppliers, contracts, contracted allotments and supplier cost prices.

-- CreateEnum
CREATE TYPE "SupplierKind" AS ENUM ('hotel', 'ground_operator', 'race_organiser', 'other');
CREATE TYPE "AllotmentKind" AS ENUM ('room', 'entry');
CREATE TYPE "AllotmentStatus" AS ENUM ('held', 'released');
CREATE TYPE "CostBasis" AS ENUM ('per_person', 'per_room', 'per_booking', 'fixed');
CREATE TYPE "CostStatus" AS ENUM ('planned', 'due', 'paid', 'cancelled');

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "kind" "SupplierKind" NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "defaultCurrency" CHAR(3) NOT NULL,
    "paymentTerms" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_contacts" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "supplier_contacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_contracts" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "editionId" UUID,
    "reference" TEXT NOT NULL,
    "signedAt" DATE,
    "validFrom" DATE,
    "validTo" DATE,
    "terms" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ(3),
    "deletedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "supplier_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "allotments" (
    "id" UUID NOT NULL,
    "contractId" UUID NOT NULL,
    "poolId" UUID NOT NULL,
    "kind" "AllotmentKind" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "releaseDate" DATE,
    "unitCostMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "AllotmentStatus" NOT NULL DEFAULT 'held',
    "releasedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "allotments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cost_items" (
    "id" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "contractId" UUID,
    "packageId" UUID,
    "description" TEXT NOT NULL,
    "basis" "CostBasis" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitAmountMinor" BIGINT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "dueDate" DATE,
    "status" "CostStatus" NOT NULL DEFAULT 'planned',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "cost_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_kind_idx" ON "suppliers"("kind");
CREATE INDEX "supplier_contacts_supplierId_idx" ON "supplier_contacts"("supplierId");
CREATE UNIQUE INDEX "supplier_contracts_supplierId_reference_key" ON "supplier_contracts"("supplierId", "reference");
CREATE INDEX "supplier_contracts_editionId_idx" ON "supplier_contracts"("editionId");
CREATE INDEX "allotments_contractId_idx" ON "allotments"("contractId");
CREATE INDEX "allotments_poolId_status_idx" ON "allotments"("poolId", "status");
CREATE INDEX "allotments_status_releaseDate_idx" ON "allotments"("status", "releaseDate");
CREATE UNIQUE INDEX "cost_items_id_currency_key" ON "cost_items"("id", "currency");
CREATE INDEX "cost_items_supplierId_status_idx" ON "cost_items"("supplierId", "status");
CREATE INDEX "cost_items_packageId_idx" ON "cost_items"("packageId");
CREATE INDEX "cost_items_contractId_idx" ON "cost_items"("contractId");

-- AddForeignKey
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "supplier_contracts" ADD CONSTRAINT "supplier_contracts_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "supplier_contracts" ADD CONSTRAINT "supplier_contracts_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "race_editions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "allotments" ADD CONSTRAINT "allotments_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "supplier_contracts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "allotments" ADD CONSTRAINT "allotments_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "inventory_pools"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "supplier_contracts"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Business rules the database enforces as a backstop (the API checks them first).
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_codes" CHECK ("countryCode" ~ '^[A-Z]{2}$' AND "defaultCurrency" ~ '^[A-Z]{3}$');
ALTER TABLE "supplier_contracts" ADD CONSTRAINT "supplier_contracts_valid_range" CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validFrom" <= "validTo");
ALTER TABLE "allotments" ADD CONSTRAINT "allotments_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "allotments" ADD CONSTRAINT "allotments_unit_cost_sign" CHECK ("unitCostMinor" >= 0);
ALTER TABLE "allotments" ADD CONSTRAINT "allotments_currency_code" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "allotments" ADD CONSTRAINT "allotments_release_state" CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL));
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_quantity_positive" CHECK ("quantity" > 0 AND ("basis" <> 'fixed' OR "quantity" = 1));
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_unit_sign" CHECK ("unitAmountMinor" >= 0);
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_amount_sign" CHECK ("amountMinor" >= 0);
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_amount_is_quantity_times_unit" CHECK ("amountMinor" = "quantity"::bigint * "unitAmountMinor");
ALTER TABLE "cost_items" ADD CONSTRAINT "cost_items_currency_code" CHECK ("currency" ~ '^[A-Z]{3}$');
