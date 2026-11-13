import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MARKETING_WORDING_KEY } from '@mt/shared';
import type { AccountPrivacyView, StaffPrivacyView } from '@mt/shared';
import { PrivacyPanel } from '@/components/admin/privacy-panel';
import { PrivacySettings } from '@/components/privacy/privacy-settings';

// Task 5.5: the customer's privacy page and the panel's privacy section, rendered from what the API sends.
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const view = (over: Partial<AccountPrivacyView> = {}): AccountPrivacyView => ({
  hasCustomerRecord: true, marketingConsent: { granted: false, recordedAt: null }, wordingKey: MARKETING_WORDING_KEY, erasureRequest: null, ...over,
});
const staff = (over: Partial<StaffPrivacyView> = {}): StaffPrivacyView => ({
  anonymised: false, marketingConsent: { granted: true, recordedAt: '2026-11-01T01:00:00.000Z' },
  consentHistory: [{ granted: true, source: 'account', recordedAt: '2026-11-01T01:00:00.000Z' }],
  requests: [{ kind: 'erasure', status: 'received', requestedBy: 'customer', requestedAt: '2026-11-02T01:00:00.000Z', completedAt: null }],
  erasure: { possible: true, blockedBy: null }, ...over,
});

describe('the privacy page', () => {
  it('marketing consent is unticked unless the API says it was given, and its wording is shown', () => {
    const off = renderToStaticMarkup(<PrivacySettings initial={view()} />);
    const box = (html: string) => /<input[^>]*name="marketing"[^>]*>/.exec(html)![0];
    expect(box(off)).not.toContain('checked');
    expect(text(off)).toContain('Email me about new race trips');
    const on = renderToStaticMarkup(<PrivacySettings initial={view({ marketingConsent: { granted: true, recordedAt: '2026-11-03T00:00:00.000Z' } })} />);
    expect(box(on)).toContain('checked');
    expect(text(on)).toContain('3 November 2026');
  });

  it('the download is a plain link to the API; erasure is a request, or the account-only delete with a confirmation', () => {
    const html = renderToStaticMarkup(<PrivacySettings initial={view()} />);
    expect(html).toContain('href="/api/account/privacy/export"');
    expect(text(html)).toContain('Ask us to delete my data');
    expect(text(renderToStaticMarkup(<PrivacySettings initial={view({ erasureRequest: { status: 'received', requestedAt: '2026-11-04T00:00:00.000Z' } })} />))).toContain('We received your request on 4 November 2026');
    const account = renderToStaticMarkup(<PrivacySettings initial={view({ hasCustomerRecord: false })} />);
    expect(text(account)).toContain('Delete my sign-in account');
    expect(account).toMatch(/<button[^>]*disabled=""[^>]*>Delete my sign-in account/);
  });

  it('the panel shows states and dates, never ids, and only lets an owner erase after ticking the confirmation', () => {
    const html = renderToStaticMarkup(<PrivacyPanel id="018f0000-0000-7000-8000-000000000000" initial={staff()} />);
    expect(text(html)).toContain('Marketing emails: yes, since 1 November 2026');
    expect(text(html)).toContain('2 November 2026: erasure, waiting (asked by the customer)');
    expect(html).not.toContain('018f0000');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Erase personal data/);
    const blocked = text(renderToStaticMarkup(<PrivacyPanel id="x" initial={staff({ erasure: { possible: false, blockedBy: 'refund_may_be_due' } })} />));
    expect(blocked).toContain('may need to be refunded');
    expect(blocked).not.toContain('Erase personal data');
  });
});
