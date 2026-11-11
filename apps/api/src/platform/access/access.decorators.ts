import { SetMetadata, applyDecorators } from '@nestjs/common';
import type { UserKind } from './auth-context';

/**
 * Every route declares exactly one access mark (plan 4.1); AccessGuard denies a route with none or with two, and a
 * test walks every registered route.
 */
export const ACCESS_MARK = 'access-mark';

export type OwnedBySpec =
  /** The route acts only on the caller's own user: it takes no resource id (checked by a test). */
  | { kind: UserKind; resource: 'self' }
  /** A customer resource: `fixture` names the test data that proves another customer is refused. */
  | { kind: 'customer'; resource: string; fixture: string; owns: (ctx: { userId: string; params: Record<string, string> }) => Promise<boolean> };

export type AccessMark =
  | { type: 'public'; exposes: string }
  | { type: 'owned'; spec: OwnedBySpec }
  | { type: 'permission'; key: string };

const MARK_KEYS = { public: 'access-mark:public', owned: 'access-mark:owned', permission: 'access-mark:permission' } as const;
export const ACCESS_MARK_KEYS = Object.values(MARK_KEYS);

/** No session needed. `exposes` says what an anonymous caller can reach, for review. */
export const Public = (exposes: string) => applyDecorators(SetMetadata(MARK_KEYS.public, { type: 'public', exposes } satisfies AccessMark));

/** A signed-in user acting on something of their own. */
export const OwnedBy = (spec: OwnedBySpec) => applyDecorators(SetMetadata(MARK_KEYS.owned, { type: 'owned', spec } satisfies AccessMark));

/** Staff with this permission (and a recent TOTP check if the permission requires step-up). */
export const RequirePermission = (key: string) => applyDecorators(SetMetadata(MARK_KEYS.permission, { type: 'permission', key } satisfies AccessMark));
