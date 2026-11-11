-- Task 0.3: users, sessions, sign-in tokens, roles and permissions, audit log (docs/plans/0.3-auth-roles-audit.md).

-- CreateEnum
CREATE TYPE "UserKind" AS ENUM ('staff', 'customer');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "LoginTokenPurpose" AS ENUM ('magic_link', 'staff_mfa', 'staff_enrolment');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('staff', 'customer', 'system', 'automation', 'api_key');

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "kind" "UserKind" NOT NULL,
    "email" CITEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "passwordHash" TEXT,
    "totpSecretCiphertext" TEXT,
    "totpKeyVersion" INTEGER,
    "totpEnabledAt" TIMESTAMPTZ(3),
    "totpLastUsedStep" BIGINT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailedLoginAt" TIMESTAMPTZ(3),
    "nextLoginAllowedAt" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "anonymisedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "UserKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mfaVerifiedAt" TIMESTAMPTZ(3),
    "stepUpFailures" INTEGER NOT NULL DEFAULT 0,
    "userAgent" TEXT,
    "ipPrefix" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "revokeReason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_tokens" (
    "id" UUID NOT NULL,
    "purpose" "LoginTokenPurpose" NOT NULL,
    "email" CITEXT NOT NULL,
    "userId" UUID,
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "requiresStepUp" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionKey")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" UUID NOT NULL,
    "userKind" "UserKind" NOT NULL DEFAULT 'staff',
    "roleId" UUID NOT NULL,
    "scope" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "requestId" TEXT,
    "sessionId" UUID,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_pii_values" (
    "id" UUID NOT NULL,
    "auditLogId" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "subjectCustomerId" UUID,
    "subjectUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_pii_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_kind_email_key" ON "users"("kind", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_kind_key" ON "users"("id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_codes_codeHash_key" ON "recovery_codes"("codeHash");

-- CreateIndex
CREATE INDEX "recovery_codes_userId_idx" ON "recovery_codes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "login_tokens_tokenHash_key" ON "login_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "login_tokens_userId_purpose_idx" ON "login_tokens"("userId", "purpose");

-- CreateIndex
CREATE INDEX "login_tokens_expiresAt_idx" ON "login_tokens"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_occurredAt_idx" ON "audit_logs"("entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_occurredAt_idx" ON "audit_logs"("actorId", "occurredAt");

-- CreateIndex
CREATE INDEX "audit_pii_values_auditLogId_idx" ON "audit_pii_values"("auditLogId");

-- CreateIndex
CREATE INDEX "audit_pii_values_subjectCustomerId_idx" ON "audit_pii_values"("subjectCustomerId");

-- CreateIndex
CREATE INDEX "audit_pii_values_subjectUserId_idx" ON "audit_pii_values"("subjectUserId");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_kind_fkey" FOREIGN KEY ("userId", "kind") REFERENCES "users"("id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_userKind_fkey" FOREIGN KEY ("userId", "userKind") REFERENCES "users"("id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_pii_values" ADD CONSTRAINT "audit_pii_values_auditLogId_fkey" FOREIGN KEY ("auditLogId") REFERENCES "audit_logs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------------------------------------------
-- Hand-written below: what Prisma cannot express.

-- Only staff have a password and TOTP; customers sign in by magic link.
ALTER TABLE "users" ADD CONSTRAINT "users_staff_only_credentials_check"
  CHECK ("kind" = 'staff' OR ("passwordHash" IS NULL AND "totpSecretCiphertext" IS NULL AND "totpEnabledAt" IS NULL AND "totpLastUsedStep" IS NULL));
ALTER TABLE "users" ADD CONSTRAINT "users_totp_key_version_check"
  CHECK (("totpSecretCiphertext" IS NULL) = ("totpKeyVersion" IS NULL));
ALTER TABLE "users" ADD CONSTRAINT "users_totp_enabled_needs_secret_check"
  CHECK ("totpEnabledAt" IS NULL OR "totpSecretCiphertext" IS NOT NULL);
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_count_check" CHECK ("failedLoginCount" >= 0);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_step_up_failures_check" CHECK ("stepUpFailures" >= 0);
ALTER TABLE "login_tokens" ADD CONSTRAINT "login_tokens_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5);
-- Only staff hold roles; scoped roles fail closed until scoped access exists (plan 4.3).
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_staff_only_check" CHECK ("userKind" = 'staff');
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_scope_null_check" CHECK ("scope" IS NULL);
ALTER TABLE "roles" ADD CONSTRAINT "roles_key_format_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{1,39}$');

-- Append-only tables (plan 4.9): a trigger rejects UPDATE, DELETE and TRUNCATE for every role, the owner included.
-- audit_pii_values allows DELETE only when current_user = 'mt_privacy': inside its SECURITY DEFINER functions, or
-- by mt_owner after SET ROLE mt_privacy (mt_owner runs migrations only and could drop the triggers anyway; accepted).
CREATE FUNCTION public.mt_reject_modification() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE FUNCTION public.mt_audit_pii_delete_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'mt_privacy' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();
CREATE TRIGGER audit_pii_values_append_only BEFORE UPDATE OR DELETE ON "audit_pii_values"
  FOR EACH ROW EXECUTE FUNCTION public.mt_audit_pii_delete_guard();
CREATE TRIGGER audit_pii_values_no_truncate BEFORE TRUNCATE ON "audit_pii_values"
  FOR EACH STATEMENT EXECUTE FUNCTION public.mt_reject_modification();

-- Defence in depth: the API role cannot even try.
REVOKE UPDATE, DELETE ON "audit_logs", "audit_pii_values" FROM mt_app;

-- mt_privacy: exactly what its functions need, nothing else.
GRANT USAGE ON SCHEMA public TO mt_privacy;
GRANT SELECT, DELETE ON "audit_pii_values" TO mt_privacy;
GRANT SELECT, INSERT ON "audit_logs" TO mt_privacy;

-- Purges personal values of audit rows that belong to no customer and are older than 7 years (plan 4.4), and
-- records that it ran. Owned by mt_privacy, fixed search_path, every object schema-qualified, EXECUTE only for mt_app.
CREATE FUNCTION public.privacy_purge_expired() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM public.audit_pii_values v
   USING public.audit_logs l
   WHERE v."auditLogId" = l.id
     AND v."subjectCustomerId" IS NULL
     AND v."subjectUserId" IS NULL
     AND l."occurredAt" < pg_catalog.now() - interval '7 years';
  GET DIAGNOSTICS deleted = ROW_COUNT;
  INSERT INTO public.audit_logs (id, "actorType", action, "entityType", "entityId", changes)
  VALUES (pg_catalog.gen_random_uuid(), 'system', 'privacy.retention.purged', 'AuditPiiValue',
          '00000000-0000-0000-0000-000000000000', pg_catalog.jsonb_build_object('deleted', deleted));
  RETURN deleted;
END;
$$;

-- mt_owner may hand the function to mt_privacy (membership granted by docker/db/init/01-roles.sql); the new owner
-- needs CREATE on the schema only for the ALTER, so it is granted and taken back around it.
-- Privileges are set first: the ACL carries over to the new owner, and mt_owner cannot change it afterwards.
REVOKE ALL ON FUNCTION public.privacy_purge_expired() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_purge_expired() TO mt_app;
GRANT CREATE ON SCHEMA public TO mt_privacy;
ALTER FUNCTION public.privacy_purge_expired() OWNER TO mt_privacy;
REVOKE CREATE ON SCHEMA public FROM mt_privacy;

-- Trigger functions are not callable directly by anyone but their owner.
REVOKE ALL ON FUNCTION public.mt_reject_modification() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mt_audit_pii_delete_guard() FROM PUBLIC;

-- Queue for the daily auth maintenance job (must match apps/api/src/platform/jobs/queues.ts).
SELECT pgboss.create_queue('auth.maintenance', '{"policy":"short","retryLimit":2,"retryDelay":60,"expireInSeconds":600,"deleteAfterSeconds":604800}'::jsonb);
