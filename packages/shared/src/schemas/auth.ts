import { z } from 'zod';

// Request bodies of the auth and admin-access routes (task 0.3), shared by the API (validation) and the web app.
// Strict objects: an unknown field is a 422, so a one-time token can only ever travel in the documented field.

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const oneTimeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const totpCodeSchema = z.string().regex(/^\d{6}$/);
export const recoveryCodeSchema = z.string().trim().min(16).max(24);
export const passwordSchema = z.string().min(12).max(256);
export const reasonSchema = z.string().trim().min(1).max(500).optional();
export const roleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

export const staffSignInSchema = z.strictObject({ email: emailSchema, password: z.string().min(1).max(256) });
export const staffMfaSchema = z.union([z.strictObject({ code: totpCodeSchema }), z.strictObject({ recoveryCode: recoveryCodeSchema })]);
export const stepUpSchema = z.strictObject({ code: totpCodeSchema });
export const tokenBodySchema = z.strictObject({ token: oneTimeTokenSchema });
export const enrolmentCompleteSchema = z.strictObject({ token: oneTimeTokenSchema, password: passwordSchema, code: totpCodeSchema });
export const magicLinkRequestSchema = z.strictObject({ email: emailSchema });

export const createStaffSchema = z.strictObject({ email: emailSchema, roleKeys: z.array(roleKeySchema).max(20).default([]), reason: reasonSchema });
/** `scope` is accepted only to be refused with 422 until scoped access exists (plan 4.3). */
export const setStaffRolesSchema = z.strictObject({ roleKeys: z.array(roleKeySchema).max(20), scope: z.unknown().optional(), reason: reasonSchema });
export const staffActionSchema = z.strictObject({ reason: reasonSchema });

export const createRoleSchema = z.strictObject({ key: roleKeySchema, name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default(''), reason: reasonSchema });
export const setRolePermissionsSchema = z.strictObject({ permissionKeys: z.array(z.string().max(100)).max(500), version: z.number().int().min(0), reason: reasonSchema });

export const setFlagSchema = z.strictObject({ enabled: z.boolean(), reason: reasonSchema });
export const setSettingSchema = z.strictObject({ value: z.unknown(), version: z.number().int().min(0), reason: reasonSchema });

export const auditQuerySchema = z.strictObject({ entityType: z.string().regex(/^[A-Za-z]{1,60}$/), entityId: z.uuid() });

export type StaffSignIn = z.infer<typeof staffSignInSchema>;
