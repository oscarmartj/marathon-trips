// The last step of `pnpm --filter @mt/api test:sandbox` (plan 3.6, 10.9): fails unless the run passed every contract
// clause, and prints the evidence line to copy into the adapter's docs/done/ note. Prints no credential.
import { readFileSync } from 'node:fs';
import { sandboxEvidence } from '../test/contract/sandbox-evidence';

const [reportPath] = process.argv.slice(2);
const key = process.env.SANDBOX_ADAPTER ?? '';
if (!reportPath || !key) {
  console.error('usage: SANDBOX_ADAPTER=<key> tsx scripts/sandbox-evidence.ts <vitest json report>');
  process.exit(1);
}
const result = sandboxEvidence(JSON.parse(readFileSync(reportPath, 'utf8')), key, new Date().toISOString().slice(0, 10));
if (!result.ok) {
  console.error(`No sandbox evidence for ${key}:\n- ${result.problems.join('\n- ')}`);
  process.exit(1);
}
console.log(result.line);
