// The contract subjects of every adapter (plan 3.6, sections 2.1, 2.4 and 10). A new adapter adds a local subject (its
// gateway faked in memory or by recorded responses, run in CI) and, to become verified, a sandbox subject (its real
// sandbox, credentials from environment variables), both built on the very class createAdapters returns.
import { createAdapters } from '../../../src/modules/payments/adapters';
import type { PaymentProvider } from '../../../src/modules/payments/core/provider';
import type { ContractSubject, SubjectFactory } from '../payment-provider.contract';
import { simulatorLocalSubject } from './simulator';

export const LOCAL_SUBJECTS: Readonly<Record<string, SubjectFactory>> = {
  simulator: simulatorLocalSubject,
};

/** None yet: no real adapter exists while money is parked. */
export const SANDBOX_SUBJECTS: Readonly<Record<string, SubjectFactory>> = {};

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
