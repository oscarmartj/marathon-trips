import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Creates two fresh enrolled owners with the API's e2e script (refuses outside test and ci) and hands them over. */
export default function globalSetup(): void {
  const apiDir = join(__dirname, '..', '..', 'api');
  const create = (...args: string[]) =>
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-staff.ts', ...args], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' });
  process.env.E2E_STAFF = create();
  process.env.E2E_STAFF_2 = create();
  process.env.E2E_STAFF_3 = create();
  process.env.E2E_STAFF_4 = create();
  process.env.E2E_STAFF_5 = create();
  process.env.E2E_STAFF_6 = create();
  process.env.E2E_STAFF_7 = create();
  process.env.E2E_STAFF_8 = create();
  process.env.E2E_STAFF_9 = create();
  // Template editors: one who can also put wording into use, one who can only read and draft (templates.spec.ts).
  process.env.E2E_STAFF_10 = create('--permissions', 'templates.template.read,templates.template.manage,templates.template.publish');
  process.env.E2E_STAFF_11 = create('--permissions', 'templates.template.read,templates.template.manage');
  // Complaints register (complaints.spec.ts): slot 12 holds every permission; slot 13 can only read.
  process.env.E2E_STAFF_12 = create();
  process.env.E2E_STAFF_13 = create('--permissions', 'complaints.complaint.read,common.table.use');
  // Automations (automations.spec.ts): an owner.
  process.env.E2E_STAFF_14 = create();
  // Waiting list offers (waitlist.spec.ts): an owner.
  process.env.E2E_STAFF_15 = create();
  // Key dates calendar (key-dates.spec.ts): an owner.
  process.env.E2E_STAFF_16 = create();
}
