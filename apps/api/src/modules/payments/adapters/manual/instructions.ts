// The business's own bank details for a manual method (task 3.4, plan section 5). Pure: no database, no network.
import type { ManualMethodConfigInput, PayIdType } from '@mt/shared';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE = /^\+[1-9]\d{7,14}$/;
const ABN = /^\d{11}$/;
const ORG_ID = /^[A-Za-z0-9]{1,32}$/;
const BSB = /^\d{3}-?\d{3}$/;
const ACCOUNT = /^\d{4,10}$/;

const PAY_ID_CHECKS: Readonly<Record<PayIdType, RegExp>> = { email: EMAIL, phone: PHONE, abn: ABN, org_id: ORG_ID };

export interface PayeeDetails {
  payeeName: string | null;
  payId: { type: PayIdType; value: string } | null;
  bank: { bsb: string; accountNumber: string } | null;
}

/** What is wrong with the payee details, as codes; empty when a customer could pay with them. */
export function payeeProblems(d: PayeeDetails): string[] {
  const problems: string[] = [];
  if (!d.payeeName) problems.push('payee_name_missing');
  if (!d.payId && !d.bank) problems.push('payee_account_missing');
  if (d.payId && !PAY_ID_CHECKS[d.payId.type].test(d.payId.value)) problems.push('payid_invalid');
  if (d.bank && !BSB.test(d.bank.bsb)) problems.push('bsb_invalid');
  if (d.bank && !ACCOUNT.test(d.bank.accountNumber)) problems.push('account_number_invalid');
  return problems;
}

/** A BSB as stored: six digits. */
export const bsbDigits = (v: string): string => v.replace('-', '');

/** The "connection test" of a manual method: its instructions exist and are valid. */
export function configProblems(c: Pick<ManualMethodConfigInput, 'enabled' | 'countries'> & PayeeDetails): string[] {
  const problems = payeeProblems(c);
  if (c.enabled && c.countries.length === 0) problems.push('countries_missing');
  return problems;
}
