// The weekly sandbox contract run (task 9.4): which adapters it covers, and the workflow that runs it. No database.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
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

interface Step { name?: string; run?: string; if?: string; uses?: string }
interface Job { needs?: string | string[]; if?: string; env?: Record<string, string>; steps?: Step[]; strategy?: { matrix?: Record<string, unknown> }; outputs?: Record<string, string> }
interface Workflow { on?: Record<string, unknown>; jobs?: Record<string, Job> }

describe('weekly workflow file', () => {
  const path = resolve(__dirname, '../../../../.github/workflows/weekly-sandbox-contract.yml');
  const text = readFileSync(path, 'utf8');
  // Parsed for real: a file GitHub would reject as invalid YAML (9.fix-1) must fail here, not only on the first Sunday.
  const wf = parse(text, { strict: true, uniqueKeys: true }) as Workflow;
  const sandbox = wf.jobs?.sandbox;
  const secretRef = /^\$\{\{ secrets\.(\w+) \}\}$/;

  it('is valid YAML with a plan job and a sandbox job', () => {
    expect(wf.jobs).toBeDefined();
    expect(Object.keys(wf.jobs ?? {}).sort()).toEqual(['plan', 'sandbox']);
    for (const [name, job] of Object.entries(wf.jobs ?? {})) {
      expect(job.steps?.length, name).toBeGreaterThan(0);
      for (const step of job.steps ?? []) expect(Boolean(step.run) !== Boolean(step.uses), `${name}: ${step.name}`).toBe(true);
    }
  });

  it('is scheduled and manual only, never on pull requests or pushes', () => {
    expect(Object.keys(wf.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch']);
    const schedule = wf.on?.schedule as { cron: string }[];
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
  });

  it('says so when nothing is verified, and skips the sandbox job', () => {
    expect(text).toContain('0 verified adapters, nothing to test');
    expect(sandbox?.needs).toBe('plan');
    expect(sandbox?.if).toBe("needs.plan.outputs.count != '0'");
    expect(wf.jobs?.plan?.outputs?.keys).toBe('${{ steps.plan.outputs.keys }}');
    expect(wf.jobs?.plan?.outputs?.count).toBe('${{ steps.plan.outputs.count }}');
  });

  it('takes the adapters from the registry, as a matrix, and credentials only from secrets', () => {
    expect(wf.jobs?.plan?.steps?.some((st) => st.run?.includes('weekly-sandbox-plan.ts'))).toBe(true);
    expect(sandbox?.strategy?.matrix?.adapter).toBe('${{ fromJSON(needs.plan.outputs.keys) }}');
    expect(sandbox?.env?.SANDBOX_ADAPTER).toBe('${{ matrix.adapter }}');
    expect(sandbox?.steps?.some((st) => st.run?.includes('test:sandbox'))).toBe(true);
    for (const [name, value] of Object.entries(sandbox?.env ?? {})) {
      if (/_(SANDBOX|TEST)_/.test(name)) expect(String(value), name).toMatch(secretRef);
    }
  });

  it('passes every environment variable any sandbox subject reads, so a new secret cannot be forgotten', () => {
    const dir = resolve(__dirname, 'subjects');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !/(-fake|-certs)\.ts$|^(index|simulator)\.ts$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const wanted = new Set<string>();
    for (const f of files) for (const m of readFileSync(resolve(dir, f), 'utf8').matchAll(/\b[A-Z][A-Z0-9_]*?_(?:SANDBOX|TEST)_[A-Z0-9_]+\b/g)) wanted.add(m[0]);
    for (const known of ['STRIPE_SANDBOX_SECRET_KEY', 'STRIPE_BNPL_SANDBOX_SECRET_KEY', 'AIRWALLEX_SANDBOX_CLIENT_ID', 'PIN_TEST_SECRET_KEY', 'EWAY_SANDBOX_API_KEY']) expect(wanted, known).toContain(known);
    const env = sandbox?.env ?? {};
    for (const name of [...wanted].sort()) {
      // A file input is a base64 secret written to a file by the "Write file inputs" step, which exports the path as NAME.
      const direct = secretRef.exec(String(env[name] ?? ''))?.[1];
      const file = secretRef.exec(String(env[`B64_${name}`] ?? ''))?.[1];
      expect(direct === name || file === `${name}_B64`, `${name} is not passed from secrets.${name}`).toBe(true);
      if (file) expect(sandbox?.steps?.find((st) => st.name?.startsWith('Write file inputs'))?.run, name).toContain(name);
    }
  });
});
