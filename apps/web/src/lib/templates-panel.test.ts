import { describe, expect, it } from 'vitest';
import { actionsFor, createBody, placeholder } from './templates-panel';
import { adminRoutes } from './routes';
import { t } from './i18n';

describe('templates panel', () => {
  it('writes a variable the way the API reads it', () => {
    expect(placeholder('givenName')).toBe('{{givenName}}');
  });

  it('trims the subject but keeps the body exactly as typed', () => {
    expect(createBody('crm.quote_sent', '  Quote  ', 'Line one\n\nLine two ')).toEqual({ key: 'crm.quote_sent', subject: 'Quote', body: 'Line one\n\nLine two ' });
  });

  it('offers only the actions that make sense for each state', () => {
    expect(actionsFor({ status: 'draft', channel: 'email' })).toEqual(['edit', 'activate', 'archive']);
    expect(actionsFor({ status: 'active', channel: 'email' })).toEqual(['archive']);
    expect(actionsFor({ status: 'archived', channel: 'email' })).toEqual([]);
    expect(actionsFor({ status: 'active', channel: 'document' })).toEqual(['archive', 'pdf']);
  });

  it('has a panel route in the navigation and its copy', () => {
    expect(adminRoutes.find((r) => r.path === '/admin/templates')?.nav).toBe(true);
    expect(t('admin.templates.status.active')).toBe('In use');
    expect(t('admin.templates.errors.template_wording_invalid')).toContain('variable');
  });
});
