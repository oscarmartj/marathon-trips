#!/usr/bin/env node
// Fails if any Vitest JSON report under the repo shows skipped, todo or pending tests, or if none exist.
// Reports are written by each package's `test` script to <package>/test-results/vitest.json.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reports = [];
for (const group of ['apps', 'packages']) {
  for (const pkg of readdirSync(join(root, group))) {
    const file = join(root, group, pkg, 'test-results/vitest.json');
    if (existsSync(file)) reports.push(file);
  }
}
if (reports.length === 0) {
  console.error('No test reports found: run the tests first.');
  process.exit(1);
}
let bad = false;
for (const file of reports) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const skipped = (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0);
  if (skipped > 0 || r.numFailedTests > 0) {
    console.error(`${file}: ${skipped} skipped/todo, ${r.numFailedTests} failed`);
    bad = true;
  }
}
if (bad) process.exit(1);
console.log(`OK: ${reports.length} reports, no skipped or todo tests`);
