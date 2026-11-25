// Prints the weekly sandbox plan as JSON: {"keys": [...]} for the adapters marked `verified` in the registry (task 9.4).
// Exits non-zero, printing why, when a verified adapter is test-only. Reads no credential and uses no network. The
// check that each verified adapter has a sandbox subject runs in CI (test/contract/weekly.test.ts) and again in
// `test:sandbox` itself, which fails without one: the subjects need the test runner, so this script does not load them.
import { createAdapters } from '../src/modules/payments/adapters';
import { weeklySandboxPlan } from '../test/contract/weekly';

const { keys, problems } = weeklySandboxPlan(createAdapters({ webOrigin: 'http://localhost:3000' }), null);
if (problems.length > 0) {
  console.error(`Weekly sandbox plan is invalid:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(JSON.stringify({ keys }));
