export type UserKind = 'staff' | 'customer';

/** The signed-in user for this request, set by AccessGuard from the session cookie of the route's user kind. */
export interface AuthContext {
  kind: UserKind;
  userId: string;
  sessionId: string;
  /** Last TOTP check in this session (sign-in or step-up); staff only. */
  mfaVerifiedAt: Date | null;
}
