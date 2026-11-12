export type UserKind = 'staff' | 'customer';

/** A signed-in user for this request, set by AccessGuard from the session cookie of the route's user kind. */
export interface SessionAuth {
  via: 'session';
  kind: UserKind;
  userId: string;
  sessionId: string;
  /** Last TOTP check in this session (sign-in or step-up); staff only. */
  mfaVerifiedAt: Date | null;
}

/**
 * A staff member's API key (task 8.4). `userId` is the key's owner, whose current permissions are intersected with the
 * key's scopes on every check. A key never has a TOTP check, so it never passes step-up.
 */
export interface ApiKeyAuth {
  via: 'api_key';
  kind: 'staff';
  userId: string;
  sessionId: null;
  mfaVerifiedAt: null;
  apiKeyId: string;
  scopes: ReadonlySet<string>;
}

export type AuthContext = SessionAuth | ApiKeyAuth;
