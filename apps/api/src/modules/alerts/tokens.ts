import { hmacHex } from '../../platform/crypto/hmac';

/** The unsubscribe link carries an HMAC of the subscription id, so nothing is stored (plan 4.6). */
export const unsubscribeTokenFor = (key: string, subscriptionId: string): string => hmacHex(key, `alert-unsubscribe:${subscriptionId}`);

export const CONFIRM_TOKEN_MS = 7 * 24 * 60 * 60 * 1000;
export const CONFIRM_TEMPLATE = { key: 'alerts.confirm', version: 1 } as const;
export const OPEN_TEMPLATE = { key: 'alerts.package_open', version: 1 } as const;
