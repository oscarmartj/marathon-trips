// pnpm --filter @mt/api test:sandbox, with SANDBOX_ADAPTER=<key> and that gateway's sandbox credentials in the
// environment (plan 3.6, section 2.4). Not part of CI or check:all: there are no keys there. A failure to resolve
// the subject fails the run; scripts/sandbox-evidence.ts then checks that every clause passed and prints the line
// a docs/done/ note needs for the adapter to be marked verified.
import { describePaymentProviderContract } from '../payment-provider.contract';
import { resolveSandboxSubject } from '../subjects';

const { key, subject } = resolveSandboxSubject(process.env);
describePaymentProviderContract(`sandbox ${key}`, subject);
