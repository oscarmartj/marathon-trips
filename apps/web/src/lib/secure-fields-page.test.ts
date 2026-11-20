// eWAY's card page (task 9.1, plan docs/plans/9.1-eway.md, sections 10.2 and 10.3): what it renders and sends, and its
// own Content-Security-Policy, which never allows the other gateway's origins. No network: eWAY's scripts are mocked.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ACCESS_CODE_PATTERN, CARD_PAGE_FRAME_ORIGINS, EWAY_CARD_FIELDS, SECURE_FIELD_CODE_PATTERN, SECURE_FIELDS_PAGE_ORIGINS } from '@mt/shared';
import { SecureFieldsPage } from '@/components/pay/secure-fields-page';
import { proxy } from '@/proxy';
import { contentSecurityPolicy, usesCardFields, usesNonce, usesSecureFields } from './csp';
import { ACCESS_CODE, SECURE_FIELD_CODE, SECURE_FIELD_CONTAINERS, secureAuthoriseBody, secureFieldsErrorKey, secureSubmitBody } from './secure-fields-page';
import { capabilitiesText } from './gateways-panel';
import { t } from './i18n';

const request = (path: string) => ({ headers: new Headers(), method: 'GET', nextUrl: new URL(`http://localhost:3000${path}`), url: `http://localhost:3000${path}`, cookies: { get: () => undefined } });

describe('eWAY Secure Fields page (task 9.1)', () => {
  it('posts only the session, eWAY\'s code and the access code; declares no card input', () => {
    expect(secureSubmitBody('cs_x', 'sfc_y')).toEqual({ ref: 'cs_x', secureFieldCode: 'sfc_y' });
    expect(secureAuthoriseBody('cs_x', 'AC1', 'sfc_y')).toEqual({ ref: 'cs_x', accessCode: 'AC1', secureFieldCode: 'sfc_y' });
    const src = readFileSync(join(__dirname, '../components/pay/secure-fields-page.tsx'), 'utf8');
    expect(/<input|<select|<textarea/.test(src)).toBe(false);
    expect(SECURE_FIELD_CONTAINERS.map((c) => c.fieldType)).toEqual(['name', 'card', 'expiry', 'cvn']);
    expect(SECURE_FIELD_CODE.source).toBe(SECURE_FIELD_CODE_PATTERN.source);
    expect(ACCESS_CODE.source).toBe(ACCESS_CODE_PATTERN.source);
  });

  it('renders the loading state first; error keys come from a closed list with copy', () => {
    expect(renderToStaticMarkup(createElement(SecureFieldsPage, { sessionRef: `cs_${'a'.repeat(32)}` }))).toContain('Getting your payment ready');
    expect([secureFieldsErrorKey(409, 'card_session_phone_required'), secureFieldsErrorKey(409, 'card_session_not_open'), secureFieldsErrorKey(400, undefined), secureFieldsErrorKey(429, undefined), secureFieldsErrorKey(500, undefined)])
      .toEqual(['phoneRequired', 'notOpen', 'invalid', 'tooMany', 'generic']);
    const messages = JSON.parse(readFileSync(join(__dirname, '../../messages/en-AU.json'), 'utf8')) as { cardPage: { errors: Record<string, string>; secureFieldsNote: string } };
    for (const k of ['phoneRequired', 'challengeUnavailable']) expect(messages.cardPage.errors[k], k).toBeTruthy();
    expect(messages.cardPage.secureFieldsNote).toBeTruthy();
    expect(/official|accredit|guarantee/i.test(JSON.stringify(messages.cardPage))).toBe(false);
  });

  it('csp: /pay/secure-fields/* allows eWAY only, /pay/card/* Pin only, every other page neither', async () => {
    expect([usesSecureFields('/pay/secure-fields/cs_x'), usesCardFields('/pay/secure-fields/cs_x'), usesNonce('/pay/secure-fields/cs_x')]).toEqual([true, false, true]);
    const eway = contentSecurityPolicy({ nonce: 'n', dev: false, secureFields: true });
    const pin = contentSecurityPolicy({ nonce: 'n', dev: false, cardFields: true });
    for (const o of SECURE_FIELDS_PAGE_ORIGINS) {
      expect(eway).toContain(o);
      expect(pin).not.toContain(o);
    }
    for (const o of CARD_PAGE_FRAME_ORIGINS) expect(eway).not.toContain(o);
    expect(SECURE_FIELDS_PAGE_ORIGINS).toEqual([...EWAY_CARD_FIELDS.frameOrigins]);
    const res = await proxy(request(`/pay/secure-fields/cs_${'a'.repeat(32)}`) as never);
    const csp = res.headers.get('Content-Security-Policy')!;
    expect(/frame-src ([^;]+)/.exec(csp)![1]).toBe(SECURE_FIELDS_PAGE_ORIGINS.join(' '));
    const other = (await proxy(request('/account') as never)).headers.get('Content-Security-Policy')!;
    expect(other).toContain(`frame-src 'none'`);
  });
});

describe('gateway catalogue capabilities (task 9.1, section 13)', () => {
  it('words from closed lists; planned entries say not installed', () => {
    expect(capabilitiesText(null)).toEqual([t('admin.gateways.catalogue.capability.none')]);
    expect(capabilitiesText({ refunds: 'partial', deferredCapture: false, disputes: false, reconciliation: null, gatewayEvents: 'none', cardEntry: 'card_fields' }))
      .toEqual([t('admin.gateways.catalogue.capability.cardEntryCardFields'), t('admin.gateways.catalogue.capability.refundsPartial'), t('admin.gateways.catalogue.capability.eventsNone')]);
    expect(capabilitiesText({ refunds: 'full', deferredCapture: false, disputes: true, reconciliation: { activity: true, settlements: false }, gatewayEvents: 'signed', cardEntry: 'gateway_page' })).toHaveLength(5);
    for (const x of capabilitiesText({ refunds: 'none', deferredCapture: false, disputes: true, reconciliation: { activity: true, settlements: true }, gatewayEvents: 'signed', cardEntry: 'manual' })) expect(x.startsWith('admin.')).toBe(false);
  });
});
