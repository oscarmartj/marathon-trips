import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../platform/errors/safe-error';
import { CONTRACT_CLAUSES } from './contract-clauses';
import type { AdapterManifest, PaymentProvider } from './provider';

const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+$/;
/**
 * Only a test-only adapter (never in staging or production) may hand out a plain-http page, with a port, an IPv6
 * literal or an underscore in the host: whatever WEB_ORIGIN local development and CI use.
 */
const TEST_ONLY_ORIGIN = /^https?:\/\/([a-z0-9._-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `text` holds the line of a complete, dated sandbox run of the current contract suite for `key` (plan 3.6, 10.9). */
export function hasSandboxEvidence(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`test:sandbox ${escaped} (\\d{4}-\\d{2}-\\d{2}) (\\d+)/(\\d+)(?!\\d)`, 'g');
  for (const m of text.matchAll(re)) {
    const [, date, passed, total] = m;
    const d = DATE.exec(date!);
    const parsed = d ? new Date(`${date}T00:00:00Z`) : null;
    const validDate = !!parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date!);
    if (validDate && Number(passed) === CONTRACT_CLAUSES.length && Number(total) === CONTRACT_CLAUSES.length) return true;
  }
  return false;
}

/**
 * Checks a list of manifests (plan 3.1, section 2.3; plan 3.6, section 10): unique keys; hosted card data only; an
 * https checkout origin (http allowed only for a test-only adapter); a verified adapter cites its sandbox evidence, a
 * file under docs/done/ with the line "test:sandbox <key> <date> N/N" of a complete run of the current contract suite;
 * a test-only adapter is never verified. Returns one message per problem. `repoRoot` lets the CI test read the files.
 */
export function manifestProblems(manifests: readonly AdapterManifest[], repoRoot?: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    if (seen.has(m.key)) problems.push(`${m.key}: duplicate adapter key`);
    seen.add(m.key);
    if (m.cardDataHandling !== 'hosted_only') problems.push(`${m.key}: card data must stay on the gateway's hosted page`);
    if (!(m.testOnly ? TEST_ONLY_ORIGIN : HTTPS_ORIGIN).test(m.checkoutOrigin)) problems.push(`${m.key}: checkout origin must be an https origin`);
    problems.push(...accountSetupProblems(m));
    if (m.status === 'verified') {
      if (m.testOnly) problems.push(`${m.key}: a test-only adapter cannot be verified`);
      if (!m.evidence || !/^docs\/done\/[\w.-]+\.md$/.test(m.evidence)) problems.push(`${m.key}: verified without sandbox evidence (docs/done/…)`);
      else if (repoRoot) {
        const p = join(repoRoot, m.evidence);
        if (!existsSync(p)) problems.push(`${m.key}: evidence file ${m.evidence} does not exist`);
        else if (!hasSandboxEvidence(readFileSync(p, 'utf8'), m.key)) problems.push(`${m.key}: evidence file does not record a test:sandbox run`);
      }
    }
  }
  return problems;
}

const FIELD_KEY = /^[a-z][A-Za-z0-9]{1,40}$/;

/** Whether `source` compiles and is anchored at both ends. */
function anchoredPattern(source: string): boolean {
  if (!source.startsWith('^') || !source.endsWith('$')) return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** The account descriptor of a manifest (plan 4.1, section 2): unique field keys, anchored patterns, a secret source. */
export function accountSetupProblems(m: AdapterManifest): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  const setup = m.account;
  if (!setup) return [`${m.key}: no account descriptor`];
  for (const f of [...setup.fields, ...(setup.generated ?? [])]) {
    if (!FIELD_KEY.test(f.key)) problems.push(`${m.key}: credential key ${f.key} is not a plain name`);
    if (keys.has(f.key)) problems.push(`${m.key}: duplicate credential key ${f.key}`);
    keys.add(f.key);
  }
  for (const f of setup.fields) if (!anchoredPattern(f.pattern)) problems.push(`${m.key}: pattern of ${f.key} must compile and be anchored`);
  for (const g of setup.generated ?? []) if (!/^[a-z0-9_]{1,20}$/.test(g.prefix)) problems.push(`${m.key}: prefix of ${g.key} is not plain`);
  if (setup.webhookSecret.source === 'entered' && !anchoredPattern(setup.webhookSecret.pattern)) problems.push(`${m.key}: webhook secret pattern must compile and be anchored`);
  return problems;
}

/** The adapters the API can use, from the static list in adapters/index.ts, checked when the API starts. */
export class PaymentAdapterRegistry {
  private readonly byKey = new Map<string, PaymentProvider>();

  constructor(adapters: readonly PaymentProvider[]) {
    const problems = manifestProblems(adapters.map((a) => a.manifest));
    if (problems.length > 0) throw new AppError('payment_adapters_invalid', `Payment adapter manifests are invalid: ${problems.join('; ')}`);
    for (const a of adapters) this.byKey.set(a.manifest.key, a);
  }

  get(key: string): PaymentProvider | undefined {
    return this.byKey.get(key);
  }

  all(): PaymentProvider[] {
    return [...this.byKey.values()];
  }
}
