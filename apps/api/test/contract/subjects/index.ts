// The contract subjects of every adapter (plan 3.6, sections 2.1, 2.4 and 10). A new adapter adds a local subject (its
// gateway faked in memory or by recorded responses, run in CI) and, to become verified, a sandbox subject (its real
// sandbox, credentials from environment variables), both built on the very class createAdapters returns.
import { createAdapters } from '../../../src/modules/payments/adapters';
import type { PaymentProvider } from '../../../src/modules/payments/core/provider';
import type { ContractSubject, SubjectFactory } from '../payment-provider.contract';
import { airwallexLocalSubject, airwallexSandboxSubject } from './airwallex';
import { ewayLocalSubject, ewaySandboxSubject } from './eway';
import { paypalLocalSubject, paypalSandboxSubject } from './paypal';
import { pinLocalSubject, pinSandboxSubject } from './pin';
import { simulatorLocalSubject } from './simulator';
import { stripeLocalSubject, stripeSandboxSubject } from './stripe';

export const LOCAL_SUBJECTS: Readonly<Record<string, SubjectFactory>> = {
  simulator: simulatorLocalSubject,
  stripe: () => stripeLocalSubject(),
  paypal: () => paypalLocalSubject(),
  pin_payments: () => pinLocalSubject(),
  eway: () => ewayLocalSubject(),
  airwallex: () => airwallexLocalSubject(),
};

/** Stripe's sandbox (task 3.3) and PayPal's (task 4.3): unverified until Oscar's sandbox keys exist. */
export const SANDBOX_SUBJECTS: Readonly<Record<string, SubjectFactory>> = {
  stripe: stripeSandboxSubject,
  paypal: paypalSandboxSubject,
  pin_payments: pinSandboxSubject,
  eway: ewaySandboxSubject,
  airwallex: airwallexSandboxSubject,
};

/** The adapters as the API builds them (the web origin only shapes the simulator's hosted page). */
export const registeredAdapters = (): PaymentProvider[] => createAdapters({ webOrigin: 'http://localhost:3000' });

/** What is wrong with the subjects for these adapters, one message each. */
export function subjectProblems(adapters: readonly PaymentProvider[], local: Readonly<Record<string, SubjectFactory>>, sandbox: Readonly<Record<string, SubjectFactory>>): string[] {
  const problems: string[] = [];
  const byKey = new Map(adapters.map((a) => [a.manifest.key, a]));
  for (const a of adapters) if (!local[a.manifest.key]) problems.push(`${a.manifest.key}: no local contract subject`);
  for (const a of adapters) if (a.manifest.status === 'verified' && !a.manifest.testOnly && !sandbox[a.manifest.key]) problems.push(`${a.manifest.key}: verified without a sandbox contract subject`);
  for (const [kind, subjects] of [['local', local], ['sandbox', sandbox]] as const) {
    for (const [key, factory] of Object.entries(subjects)) {
      const registered = byKey.get(key);
      if (!registered) {
        problems.push(`${key}: ${kind} subject for an adapter that is not registered`);
        continue;
      }
      if (factory().provider.constructor !== registered.constructor) problems.push(`${key}: ${kind} subject does not use the registered adapter class`);
    }
  }
  return problems;
}

/**
 * Sandbox subjects whose credential check accepts an environment with nothing in it (CI expects none). A factory only
 * builds objects: it must not touch the network, since it runs before the credential check (see the guide).
 */
export function sandboxSubjectsAcceptingEmptyEnv(subjects: Readonly<Record<string, SubjectFactory>>): string[] {
  return Object.entries(subjects).filter(([, factory]) => {
    try {
      factory().assertSandboxCredentials({});
      return true;
    } catch {
      return false;
    }
  }).map(([key]) => key);
}

/**
 * The subject `pnpm --filter @mt/api test:sandbox` runs (plan 3.6, 2.4 and 10.2). Throws, so the run fails rather
 * than skips, when SANDBOX_ADAPTER is unset or unknown, the adapter is test-only, it has no sandbox subject, the
 * subject is not built on the registered class, or the environment does not hold test-mode credentials. The last
 * check runs before any network call.
 */
export function resolveSandboxSubject(
  env: NodeJS.ProcessEnv,
  opts: { adapters?: readonly PaymentProvider[]; subjects?: Readonly<Record<string, SubjectFactory>> } = {},
): { key: string; subject: ContractSubject } {
  const adapters = opts.adapters ?? registeredAdapters();
  const subjects = opts.subjects ?? SANDBOX_SUBJECTS;
  const key = env.SANDBOX_ADAPTER;
  if (!key) throw new Error('test:sandbox: set SANDBOX_ADAPTER to the adapter key to test');
  const adapter = adapters.find((a) => a.manifest.key === key);
  if (!adapter) throw new Error(`test:sandbox: no adapter "${key}"`);
  if (adapter.manifest.testOnly) throw new Error(`test:sandbox: "${key}" is test-only and has no sandbox`);
  const factory = subjects[key];
  if (!factory) throw new Error(`test:sandbox: "${key}" has no sandbox contract subject`);
  const subject = factory();
  if (subject.provider.constructor !== adapter.constructor) throw new Error(`test:sandbox: the "${key}" subject does not use the registered adapter class`);
  subject.assertSandboxCredentials(env);
  return { key, subject };
}
