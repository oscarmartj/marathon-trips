import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../platform/errors/safe-error';
import { CONTRACT_CLAUSES } from './contract-clauses';
import { CardSessionProvider } from './card-sessions/provider';
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
    // Task 4.4: a card page of our own is served at WEB_ORIGIN, whose shape adapterOptions guards by environment (an
    // inert https origin outside development, test and ci unless WEB_ORIGIN is a plain https origin).
    const localPage = m.testOnly || m.capabilities.preCardSession === true;
    if (!(localPage ? TEST_ONLY_ORIGIN : HTTPS_ORIGIN).test(m.checkoutOrigin)) problems.push(`${m.key}: checkout origin must be an https origin`);
    problems.push(...accountSetupProblems(m));
    problems.push(...cardFieldsProblems(m));
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

/**
 * Task 4.4 (plan 4.4, sections 5.1, 5.2 and 18 M1): hosted card fields have https origins without paths and a script
 * under one of them; `preCardSession` needs them; a browser-exposed key needs them too, and there is at most one;
 * `refundEventOurId` only comes with `preCardSession`.
 */
export function cardFieldsProblems(m: AdapterManifest): string[] {
  const problems: string[] = [];
  const f = m.cardFields;
  if (f) {
    const origins = [...f.frameOrigins, ...f.challengeOrigins.test, ...f.challengeOrigins.live];
    if (f.frameOrigins.length === 0) problems.push(`${m.key}: card fields need a frame origin`);
    for (const o of origins) if (!HTTPS_ORIGIN.test(o)) problems.push(`${m.key}: card field origin ${o} must be an https origin`);
    if (!f.frameOrigins.some((o) => f.scriptUrl.startsWith(`${o}/`))) problems.push(`${m.key}: card field script must be served from a frame origin`);
  }
  if (m.capabilities.preCardSession && !f) problems.push(`${m.key}: preCardSession needs card fields`);
  if (m.capabilities.refundEventOurId && !m.capabilities.preCardSession) problems.push(`${m.key}: refundEventOurId needs preCardSession`);
  const exposed = (m.account?.fields ?? []).filter((x) => x.exposure !== undefined);
  if (exposed.length > 0 && !f) problems.push(`${m.key}: a browser-exposed key needs card fields`);
  if (exposed.length > 1) problems.push(`${m.key}: at most one browser-exposed key`);
  for (const x of exposed) if (x.exposure !== 'card_page') problems.push(`${m.key}: unknown exposure of ${x.key}`);
  return problems;
}

/**
 * Whether `source` compiles and is anchored at both ends for every alternative: `^a|b$` is not (its `b$` alternative
 * matches anywhere before the end), so a `|` outside any group or character class is refused (plan 4.1, review).
 */
export function anchoredPattern(source: string): boolean {
  if (!source.startsWith('^') || !source.endsWith('$') || source.endsWith('\\$')) return false;
  try {
    new RegExp(source);
  } catch {
    return false;
  }
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) return false;
  }
  return true;
}

function sampleProblems(key: string, label: string, pattern: string, samples: { valid: string; rejected: readonly string[] } | undefined): string[] {
  if (!samples || typeof samples.valid !== 'string' || !Array.isArray(samples.rejected) || samples.rejected.length === 0) return [`${key}: ${label} needs a valid sample and at least one rejected sample`];
  const re = new RegExp(pattern);
  const out: string[] = [];
  if (!re.test(samples.valid)) out.push(`${key}: the valid sample of ${label} does not match its pattern`);
  for (const r of samples.rejected) if (re.test(r)) out.push(`${key}: a rejected sample of ${label} matches its pattern`);
  return out;
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
  for (const f of setup.fields) {
    if (!anchoredPattern(f.pattern)) problems.push(`${m.key}: pattern of ${f.key} must compile and be anchored`);
    else problems.push(...sampleProblems(m.key, f.key, f.pattern, f.samples));
  }
  for (const g of setup.generated ?? []) if (!/^[a-z0-9_]{1,20}$/.test(g.prefix)) problems.push(`${m.key}: prefix of ${g.key} is not plain`);
  if (setup.webhookSecret.source === 'entered') {
    if (!anchoredPattern(setup.webhookSecret.pattern)) problems.push(`${m.key}: webhook secret pattern must compile and be anchored`);
    else problems.push(...sampleProblems(m.key, 'the webhook secret', setup.webhookSecret.pattern, setup.webhookSecret.samples));
  }
  return problems;
}

/** A provider declares preCardSession exactly when it is a CardSessionProvider (plan 4.4, 18 M1). */
export function preCardSessionProblems(a: PaymentProvider): string[] {
  const declares = a.manifest.capabilities.preCardSession === true;
  const isCardSession = a instanceof CardSessionProvider;
  if (declares && !isCardSession) return [`${a.manifest.key}: preCardSession without CardSessionProvider`];
  if (!declares && isCardSession) return [`${a.manifest.key}: CardSessionProvider without preCardSession`];
  if (isCardSession && a.gateway.manifest.capabilities.preCardSession) return [`${a.manifest.key}: a gateway manifest declares preCardSession`];
  return [];
}

/** The adapters the API can use, from the static list in adapters/index.ts, checked when the API starts. */
export class PaymentAdapterRegistry {
  private readonly byKey = new Map<string, PaymentProvider>();

  constructor(adapters: readonly PaymentProvider[]) {
    const problems = manifestProblems(adapters.map((a) => a.manifest));
    // Task 4.5: an adapter that reads disputes must be able to ask the gateway for one.
    for (const a of adapters) if (a.manifest.capabilities.disputes === 'events' && typeof a.retrieveDispute !== 'function') problems.push(`${a.manifest.key}: declares disputes without retrieveDispute`);
    // Task 4.4 (plan 4.4, 18 M1): the marker of a session with no gateway counterpart belongs to CardSessionProvider only.
    for (const a of adapters) problems.push(...preCardSessionProblems(a));
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
