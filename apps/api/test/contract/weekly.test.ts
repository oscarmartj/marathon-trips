// The weekly sandbox contract run (task 9.4): which adapters it covers, and the workflow that runs it. No database.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatorProvider, SimulatorWorld } from '../../src/modules/payments/adapters/simulator/simulator';
import type { AdapterManifest, PaymentProvider } from '../../src/modules/payments/core/provider';
import type { SubjectFactory } from './payment-provider.contract';
import { SANDBOX_SUBJECTS, registeredAdapters } from './subjects';
import { simulatorLocalSubject } from './subjects/simulator';
import { weeklySandboxPlan } from './weekly';

function fakeAdapter(over: Partial<AdapterManifest>): PaymentProvider {
  class FakeAdapter extends SimulatorProvider {
    override readonly manifest: AdapterManifest;
    constructor() {
      super({ webOrigin: 'https://checkout.example.com' }, new SimulatorWorld());
      this.manifest = { ...new SimulatorProvider({ webOrigin: 'https://checkout.example.com' }).manifest, ...over };
    }
  }
  return new FakeAdapter();
}
const subjectFor = (provider: PaymentProvider): SubjectFactory => () => ({ ...simulatorLocalSubject(), provider });

describe('weekly sandbox plan (task 9.4)', () => {
  it('lists only verified adapters, sorted, from the manifests', () => {
    const b = fakeAdapter({ key: 'b_gate', status: 'verified', testOnly: false, evidence: 'docs/done/x.md' });
    const a = fakeAdapter({ key: 'a_gate', status: 'verified', testOnly: false, evidence: 'docs/done/y.md' });
    const exp = fakeAdapter({ key: 'c_gate', status: 'experimental', testOnly: false });
    const sandbox = { a_gate: subjectFor(a), b_gate: subjectFor(b), c_gate: subjectFor(exp) };
    expect(weeklySandboxPlan([b, exp, a], new Set(Object.keys(sandbox)))).toEqual({ keys: ['a_gate', 'b_gate'], problems: [] });
  });

  it('never tests an experimental adapter, even when it has a sandbox subject', () => {
    const exp = fakeAdapter({ key: 'exp_gate', status: 'experimental', testOnly: false });
    expect(weeklySandboxPlan([exp], new Set(['exp_gate']))).toEqual({ keys: [], problems: [] });
    for (const key of weeklySandboxPlan(registeredAdapters(), new Set(Object.keys(SANDBOX_SUBJECTS))).keys) {
      expect(registeredAdapters().find((a) => a.manifest.key === key)?.manifest.status).toBe('verified');
    }
  });

  it('fails for a verified adapter without its sandbox subject, and for a verified test-only one', () => {
    const v = fakeAdapter({ key: 'real', status: 'verified', testOnly: false, evidence: 'docs/done/x.md' });
    expect(weeklySandboxPlan([v], new Set())).toEqual({ keys: [], problems: ['real: verified without a sandbox contract subject'] });
    expect(weeklySandboxPlan([v], null)).toEqual({ keys: ['real'], problems: [] });
    const t = fakeAdapter({ key: 'toy', status: 'verified', testOnly: true });
    expect(weeklySandboxPlan([t], new Set(['toy'])).problems).toEqual(['toy: a test-only adapter cannot be verified']);
  });

  it('the registry plan is valid today', () => {
    expect(weeklySandboxPlan(registeredAdapters(), new Set(Object.keys(SANDBOX_SUBJECTS))).problems).toEqual([]);
  });
});

describe('weekly workflow file', () => {
  const text = readFileSync(resolve(__dirname, '../../../../.github/workflows/weekly-sandbox-contract.yml'), 'utf8');

  it('is scheduled and manual only, never on pull requests', () => {
    expect(text).toMatch(/^\s+schedule:\s*$/m);
    expect(text).toMatch(/cron: "[^"]+"/);
    expect(text).toMatch(/^\s+workflow_dispatch:/m);
    expect(text).not.toMatch(/pull_request|push:/);
  });

  it('says so when nothing is verified, and skips the sandbox job', () => {
    expect(text).toContain('0 verified adapters, nothing to test');
    expect(text).toContain("needs.plan.outputs.count != '0'");
  });

  it('takes the adapters from the registry and credentials only from secrets', () => {
    expect(text).toContain('weekly-sandbox-plan.ts');
    expect(text).not.toMatch(/matrix:\s*\n\s+adapter:\s*\[/);
    for (const m of text.matchAll(/^\s+(\w+_(?:SANDBOX|TEST)_\w+):\s*(.*)$/gm)) expect(m[2], m[1]).toMatch(/^\$\{\{ secrets\.\w+ \}\}$/);
  });

  it('passes every environment variable the sandbox subjects read as a secret', () => {
    const names = ['STRIPE_SANDBOX_SECRET_KEY', 'STRIPE_SANDBOX_WEBHOOK_SECRET', 'PAYPAL_SANDBOX_CLIENT_ID', 'PAYPAL_SANDBOX_CLIENT_SECRET', 'PAYPAL_SANDBOX_WEBHOOK_ID',
      'PIN_TEST_SECRET_KEY', 'PIN_TEST_PUBLISHABLE_KEY', 'PIN_TEST_WEBHOOK_KEY', 'EWAY_SANDBOX_API_KEY', 'EWAY_SANDBOX_API_PASSWORD', 'EWAY_SANDBOX_PUBLIC_KEY'];
    for (const n of names) expect(text, n).toContain(`${n}: \${{ secrets.${n} }}`);
  });
});
