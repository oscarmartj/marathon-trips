// Which adapters the weekly sandbox contract run covers (task 9.4). The list comes from the registered manifests, never
// by hand: only `verified`, non-test-only adapters are tested, and each needs a sandbox subject or the check fails.
// `experimental` adapters are never run here: they cannot reach live mode, and without evidence they have no business
// being exercised with real keys outside a deliberate `test:sandbox` run.
import type { PaymentProvider } from '../../src/modules/payments/core/provider';

// `sandboxKeys` is the set of keys that have a sandbox subject; null skips that check (the workflow script cannot load
// the subjects, which need the test runner; CI's unit test checks them and `test:sandbox` fails without one).
export function weeklySandboxPlan(
  adapters: readonly PaymentProvider[],
  sandboxKeys: ReadonlySet<string> | null,
): { keys: string[]; problems: string[] } {
  const keys: string[] = [];
  const problems: string[] = [];
  for (const a of adapters) {
    const m = a.manifest;
    if (m.status !== 'verified') continue;
    if (m.testOnly) {
      problems.push(`${m.key}: a test-only adapter cannot be verified`);
      continue;
    }
    if (sandboxKeys && !sandboxKeys.has(m.key)) {
      problems.push(`${m.key}: verified without a sandbox contract subject`);
      continue;
    }
    keys.push(m.key);
  }
  return { keys: keys.sort(), problems };
}
