import type { TemplateChannelValue } from '@mt/shared';

/**
 * The template editor's rules as plain functions, so they can be tested without a browser. The API checks everything
 * again; this only shapes what is sent and what is shown.
 */
export interface TemplateVariable {
  name: string;
  description: string;
  sample: string;
}
export interface TemplateDefinition {
  channel: TemplateChannelValue;
  key: string;
  label: string;
  variables: TemplateVariable[];
  starter: { subject: string; body: string };
}
export interface TemplateRow {
  id: string;
  channel: TemplateChannelValue;
  key: string;
  locale: string;
  revision: number;
  status: 'draft' | 'active' | 'archived';
  subject: string;
  body: string;
  version: number;
}

/** `{{name}}`, the way a variable is typed into the wording. */
export const placeholder = (name: string): string => `{{${name}}}`;

/** The body of a create request: documents have a title in the same field as an email's subject. */
export function createBody(key: string, subject: string, body: string): { key: string; subject: string; body: string } {
  return { key, subject: subject.trim(), body };
}

/** Where a revision's actions are offered: a draft can be edited and put into use, one in use can be taken out of use. */
export function actionsFor(row: Pick<TemplateRow, 'status' | 'channel'>): Array<'edit' | 'activate' | 'archive' | 'pdf'> {
  const out: Array<'edit' | 'activate' | 'archive' | 'pdf'> = [];
  if (row.status === 'draft') out.push('edit', 'activate');
  if (row.status !== 'archived') out.push('archive');
  if (row.channel === 'document') out.push('pdf');
  return out;
}
