// Reads the JSON report of a test:sandbox run and gives the evidence line, or the reasons there is none (plan 3.6,
// 10.9): every clause of the current suite passed exactly once, nothing failed, skipped or left as todo.
import { CONTRACT_CLAUSES, sandboxEvidenceLine } from '../../src/modules/payments/core/contract-clauses';

interface VitestJsonReport {
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  numPassedTests?: number;
  testResults?: Array<{ assertionResults?: Array<{ title: string; status: string }> }>;
}

export function sandboxEvidence(report: VitestJsonReport, key: string, date: string): { ok: true; line: string } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const results = (report.testResults ?? []).flatMap((r) => r.assertionResults ?? []);
  if ((report.numFailedTests ?? 0) > 0 || results.some((r) => r.status === 'failed')) problems.push('some clauses failed');
  if ((report.numPendingTests ?? 0) > 0 || (report.numTodoTests ?? 0) > 0 || results.some((r) => r.status !== 'passed' && r.status !== 'failed')) problems.push('some clauses were skipped or left as todo');
  const passed = results.filter((r) => r.status === 'passed').map((r) => r.title);
  for (const clause of CONTRACT_CLAUSES) {
    const n = passed.filter((t) => t === clause).length;
    if (n !== 1) problems.push(`${clause}: passed ${n} times`);
  }
  const extra = passed.filter((t) => !(CONTRACT_CLAUSES as readonly string[]).includes(t));
  if (extra.length > 0) problems.push(`unexpected tests: ${extra.join(', ')}`);
  if (report.numPassedTests !== CONTRACT_CLAUSES.length) problems.push(`passed ${report.numPassedTests ?? 0} of ${CONTRACT_CLAUSES.length}`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, line: sandboxEvidenceLine(key, date, CONTRACT_CLAUSES.length) };
}
