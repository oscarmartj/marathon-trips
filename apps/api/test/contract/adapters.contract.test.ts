// CI side of the payment adapter contract (plan docs/plans/3.6-adapter-contract-suite.md, sections 2.2, 2.3 and 10):
// the whole suite for every adapter's local subject, and the checks that keep a new adapter honest (its subjects,
// its isolation, its sandbox evidence). No database.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SimulatorProvider, SimulatorWorld } from '../../src/modules/payments/adapters/simulator/simulator';
import { CONTRACT_CLAUSES, sandboxEvidenceLine } from '../../src/modules/payments/core/contract-clauses';
import type { AdapterManifest, PaymentProvider } from '../../src/modules/payments/core/provider';
import { hasSandboxEvidence, manifestProblems } from '../../src/modules/payments/core/registry';
import { CLAUSE_IMPLS, describePaymentProviderContract } from './payment-provider.contract';
import type { ContractSubject, SubjectFactory } from './payment-provider.contract';
import { sandboxEvidence } from './sandbox-evidence';
import { LOCAL_SUBJECTS, SANDBOX_SUBJECTS, registeredAdapters, resolveSandboxSubject, subjectProblems } from './subjects';
import { simulatorLocalSubject } from './subjects/simulator';

for (const [key, factory] of Object.entries(LOCAL_SUBJECTS)) describePaymentProviderContract(`local ${key}`, factory());

const adaptersDir = resolve(__dirname, '../../src/modules/payments/adapters');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Source files of each adapter folder (adapters/<key>/**), by path relative to adapters/. */
const adapterSources = (): Array<{ name: string; text: string }> =>
  readdirSync(adaptersDir).filter((d) => statSync(join(adaptersDir, d)).isDirectory())
    .flatMap((d) => filesUnder(join(adaptersDir, d)).map((p) => ({ name: relative(adaptersDir, p), text: readFileSync(p, 'utf8') })));

const FORBIDDEN_MODULES = /^(node:)?(fs|fs\/promises|child_process|process|vm|worker_threads|cluster|module|v8|inspector)$/;
const FORBIDDEN_CODE: Array<[RegExp, string]> = [
  [/\bprocess\b/, 'process'], [/\bconsole\b/, 'console'], [/\bLogger\b/, 'Logger'], [/\bglobalThis\b/, 'globalThis'],
  [/\brequire\s*\(/, 'require('], [/\beval\s*\(/, 'eval('], [/\bnew\s+Function\s*\(/, 'new Function('], [/\bimport\s*\(/, 'dynamic import'],
  [/prisma/i, 'Prisma'],
];

/** Why an adapter source breaks isolation (plan 3.1, 2.1; plan 3.6, 2.3 and 10.8). Comments are not code. */
export function adapterSourceProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const spec = m[1]!;
    if (spec.startsWith('../') && spec !== '../../core/provider') problems.push(`${name}: imports ${spec} (only ../../core/provider outside its folder)`);
    if (FORBIDDEN_MODULES.test(spec)) problems.push(`${name}: imports ${spec}`);
    if (/prisma|@nestjs|platform|modules\//i.test(spec)) problems.push(`${name}: imports ${spec}`);
  }
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [re, what] of FORBIDDEN_CODE) if (re.test(code)) problems.push(`${name}: uses ${what}`);
  return problems;
}

const CARD_FIELDS = /card_?number|\bcvc\b|\bcvv\b|\bpan\b/i;

describe('contract registry and static checks (plan 3.6, 2.3)', () => {
  it('contract_clauses_registered_once: one implementation per clause, in order', () => {
    expect(Object.keys(CLAUSE_IMPLS)).toEqual([...CONTRACT_CLAUSES]);
    expect(new Set(CONTRACT_CLAUSES).size).toBe(CONTRACT_CLAUSES.length);
  });

  it('every_adapter_has_a_local_contract_subject (and no subject without an adapter)', () => {
    expect(subjectProblems(registeredAdapters(), LOCAL_SUBJECTS, SANDBOX_SUBJECTS)).toEqual([]);
    // The rule bites: an adapter with no subject, and a subject with no adapter.
    const other = fakeAdapter({ key: 'other' });
    expect(subjectProblems([...registeredAdapters(), other], LOCAL_SUBJECTS, {})).toContain('other: no local contract subject');
    expect(subjectProblems([], LOCAL_SUBJECTS, {})).toContain('simulator: local subject for an adapter that is not registered');
  });

  it('verified_adapter_has_a_sandbox_subject', () => {
    for (const a of registeredAdapters()) expect(a.manifest.status === 'verified', `${a.manifest.key} is not verified today`).toBe(false);
    const verified = fakeAdapter({ key: 'real', status: 'verified', testOnly: false, evidence: 'docs/done/x.md' });
    const local = { ...LOCAL_SUBJECTS, real: () => ({ ...simulatorLocalSubject(), provider: verified }) };
    expect(subjectProblems([verified], local, {})).toContain('real: verified without a sandbox contract subject');
    expect(subjectProblems([verified], local, { real: () => ({ ...simulatorLocalSubject(), provider: verified }) })).not.toContain('real: verified without a sandbox contract subject');
  });

  it('sandbox_subject_uses_registered_adapter_class: a wrapper is never the subject', () => {
    const registered = registeredAdapters();
    for (const [key, factory] of [...Object.entries(LOCAL_SUBJECTS), ...Object.entries(SANDBOX_SUBJECTS)]) {
      expect(factory().provider.constructor, key).toBe(registered.find((a) => a.manifest.key === key)!.constructor);
    }
    class Wrapper extends SimulatorProvider {}
    const wrapped: SubjectFactory = () => ({ ...simulatorLocalSubject(), provider: new Wrapper({ webOrigin: 'http://localhost:3000' }, new SimulatorWorld()) });
    expect(subjectProblems(registered, { simulator: wrapped }, {})).toContain('simulator: local subject does not use the registered adapter class');
  });

  it('adapter_sources_are_isolated: no environment, logs, Prisma, platform, other modules, fs, process or eval', () => {
    const sources = adapterSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap((s) => adapterSourceProblems(s.name, s.text))).toEqual([]);
    // The check bites on each way out.
    const bad = [
      "const k = process.env.KEY;", "import p from 'node:process';", "import { readFileSync } from 'node:fs';", "import fs from 'fs/promises';",
      "import { exec } from 'child_process';", "const x = require('x');", "globalThis.fetch = f;", "eval('1');", "console.log(secret);",
      "import { Logger } from '@nestjs/common';", "import { PrismaService } from '../../../../platform/database/prisma.service';",
      "import { gateway } from '../../core/gateway';", "import { other } from '../stripe/stripe';", "const m = await import('x');", "const f = new Function('return 1');",
    ];
    for (const line of bad) expect(adapterSourceProblems('x.ts', line), line).not.toEqual([]);
    expect(adapterSourceProblems('x.ts', "// process.env in a comment\nimport { ProviderError } from '../../core/provider';\nimport { createHmac } from 'node:crypto';")).toEqual([]);
  });

  it('adapter_sources_have_no_card_fields', () => {
    for (const s of adapterSources()) expect(CARD_FIELDS.test(s.text), s.name).toBe(false);
    for (const word of ['cardNumber', 'card_number', 'cvc', 'CVV', 'pan']) expect(CARD_FIELDS.test(`const ${word} = 1`), word).toBe(true);
  });

  it('checkout_origin_https_unless_test_only', () => {
    const sim = registeredAdapters().find((a) => a.manifest.key === 'simulator')!.manifest;
    const originProblem = (m: AdapterManifest) => manifestProblems([m]).filter((p) => p.includes('checkout origin'));
    expect(sim.checkoutOrigin).toBe('http://localhost:3000');
    expect(originProblem(sim)).toEqual([]);
    expect(originProblem({ ...sim, testOnly: false })).not.toEqual([]);
    expect(originProblem({ ...sim, testOnly: false, checkoutOrigin: 'https://checkout.example.com' })).toEqual([]);
    expect(originProblem({ ...sim, testOnly: false, checkoutOrigin: 'https://checkout.example.com:8443' })).not.toEqual([]);
    expect(originProblem({ ...sim, checkoutOrigin: 'http://localhost:3000/path' })).not.toEqual([]);
    expect(originProblem({ ...sim, checkoutOrigin: 'javascript:alert(1)' })).not.toEqual([]);
  });

  it('verified_evidence_line_required: a dated, complete run of the current suite for that key', () => {
    const n = CONTRACT_CLAUSES.length;
    const line = sandboxEvidenceLine('real', '2027-02-03', n);
    expect(line).toBe(`test:sandbox real 2027-02-03 ${n}/${n}`);
    expect(hasSandboxEvidence(`- ${line}`, 'real')).toBe(true);
    expect(hasSandboxEvidence('ran test:sandbox, all good', 'real')).toBe(false);
    expect(hasSandboxEvidence(`test:sandbox real 2027-02-03 ${n - 1}/${n}`, 'real')).toBe(false);
    expect(hasSandboxEvidence(`test:sandbox real 2027-02-03 ${n - 1}/${n - 1}`, 'real')).toBe(false);
    expect(hasSandboxEvidence(`test:sandbox other 2027-02-03 ${n}/${n}`, 'real')).toBe(false);
    expect(hasSandboxEvidence(`test:sandbox real 2027-13-40 ${n}/${n}`, 'real')).toBe(false);
    expect(hasSandboxEvidence(`test:sandbox real 2027-02-03 ${n}/${n}0`, 'real')).toBe(false);
    // Through manifestProblems with an evidence file, as CI reads it.
    const root = mkdtempSync(join(tmpdir(), 'mt-evidence-'));
    mkdirSync(join(root, 'docs/done'), { recursive: true });
    writeFileSync(join(root, 'docs/done/good.md'), `# 9.1\n- ${line}\n`);
    writeFileSync(join(root, 'docs/done/vague.md'), '# 9.1\nRan test:sandbox, all good.\n');
    const real = (evidence: string) => ({ ...fakeAdapter({ key: 'real', status: 'verified', testOnly: false, evidence }).manifest, checkoutOrigin: 'https://checkout.example.com' });
    expect(manifestProblems([real('docs/done/good.md')], root)).toEqual([]);
    expect(manifestProblems([real('docs/done/vague.md')], root)).toContain('real: evidence file does not record a test:sandbox run');
  });

  it('sandbox_evidence_requires_every_clause_passed', () => {
    const pass = (titles: readonly string[], status = 'passed') => ({ testResults: [{ assertionResults: titles.map((title) => ({ title, status })) }] });
    const all = { ...pass(CONTRACT_CLAUSES), numPassedTests: CONTRACT_CLAUSES.length, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 };
    expect(sandboxEvidence(all, 'real', '2027-02-03')).toEqual({ ok: true, line: sandboxEvidenceLine('real', '2027-02-03', CONTRACT_CLAUSES.length) });
    expect(sandboxEvidence({ ...pass(CONTRACT_CLAUSES.slice(1)), numPassedTests: CONTRACT_CLAUSES.length - 1 }, 'real', '2027-02-03').ok).toBe(false);
    const skipped = pass(CONTRACT_CLAUSES);
    skipped.testResults[0]!.assertionResults[0]!.status = 'skipped';
    expect(sandboxEvidence({ ...skipped, numPassedTests: CONTRACT_CLAUSES.length - 1, numPendingTests: 1 }, 'real', '2027-02-03').ok).toBe(false);
    expect(sandboxEvidence({ ...all, numFailedTests: 1 }, 'real', '2027-02-03').ok).toBe(false);
    expect(sandboxEvidence({ ...pass([...CONTRACT_CLAUSES, CONTRACT_CLAUSES[0]!]), numPassedTests: CONTRACT_CLAUSES.length + 1 }, 'real', '2027-02-03').ok).toBe(false);
    expect(sandboxEvidence({}, 'real', '2027-02-03').ok).toBe(false);
  });

  it('sandbox_runner_refuses_unset_unknown_and_test_only', () => {
    expect(() => resolveSandboxSubject({})).toThrow(/SANDBOX_ADAPTER/);
    expect(() => resolveSandboxSubject({ SANDBOX_ADAPTER: 'nope' })).toThrow(/no adapter/);
    expect(() => resolveSandboxSubject({ SANDBOX_ADAPTER: 'simulator' })).toThrow(/test-only/);
    const real = fakeAdapter({ key: 'real', testOnly: false });
    expect(() => resolveSandboxSubject({ SANDBOX_ADAPTER: 'real' }, { adapters: [real], subjects: {} })).toThrow(/no sandbox contract subject/);
    expect(() => resolveSandboxSubject({ SANDBOX_ADAPTER: 'real' }, { adapters: [real], subjects: { real: () => ({ ...simulatorLocalSubject(), assertSandboxCredentials() {} }) } })).toThrow(/registered adapter class/);
  });

  it('sandbox_runner_refuses_live_looking_credentials, before any network call', () => {
    const real = fakeAdapter({ key: 'real', testOnly: false });
    let networkCalls = 0;
    const subject = (): ContractSubject => ({
      ...simulatorLocalSubject(),
      provider: real,
      async context() {
        networkCalls++;
        throw new Error('no network expected');
      },
      assertSandboxCredentials(env) {
        if (!/^sk_test_/.test(env.REAL_SECRET_KEY ?? '')) throw new Error('test:sandbox: REAL_SECRET_KEY is not a test key');
      },
    });
    expect(() => resolveSandboxSubject({ SANDBOX_ADAPTER: 'real', REAL_SECRET_KEY: 'sk_live_abc' }, { adapters: [real], subjects: { real: subject } })).toThrow(/not a test key/);
    expect(() => resolveSandboxSubject({ SANDBOX_ADAPTER: 'real' }, { adapters: [real], subjects: { real: subject } })).toThrow(/not a test key/);
    expect(resolveSandboxSubject({ SANDBOX_ADAPTER: 'real', REAL_SECRET_KEY: 'sk_test_abc' }, { adapters: [real], subjects: { real: subject } }).key).toBe('real');
    expect(networkCalls).toBe(0);
  });
});

/** An adapter of another class with a manifest of our choosing (for the rule checks only; it never charges). */
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
