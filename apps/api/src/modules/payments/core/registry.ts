import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../platform/errors/safe-error';
import type { AdapterManifest, PaymentProvider } from './provider';

/**
 * Checks a list of manifests (plan 3.1, section 2.3): unique keys; hosted card data only; a verified adapter cites its
 * sandbox evidence, a file under docs/done/ that mentions test:sandbox; a test-only adapter is never verified. Returns
 * one message per problem. `repoRoot` lets the CI test read the evidence files.
 */
export function manifestProblems(manifests: readonly AdapterManifest[], repoRoot?: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    if (seen.has(m.key)) problems.push(`${m.key}: duplicate adapter key`);
    seen.add(m.key);
    if (m.cardDataHandling !== 'hosted_only') problems.push(`${m.key}: card data must stay on the gateway's hosted page`);
    if (!/^https:\/\/[a-z0-9.-]+$/.test(m.checkoutOrigin)) problems.push(`${m.key}: checkout origin must be an https origin`);
    if (m.status === 'verified') {
      if (m.testOnly) problems.push(`${m.key}: a test-only adapter cannot be verified`);
      if (!m.evidence || !/^docs\/done\/[\w.-]+\.md$/.test(m.evidence)) problems.push(`${m.key}: verified without sandbox evidence (docs/done/…)`);
      else if (repoRoot) {
        const p = join(repoRoot, m.evidence);
        if (!existsSync(p)) problems.push(`${m.key}: evidence file ${m.evidence} does not exist`);
        else if (!readFileSync(p, 'utf8').includes('test:sandbox')) problems.push(`${m.key}: evidence file does not record a test:sandbox run`);
      }
    }
  }
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
