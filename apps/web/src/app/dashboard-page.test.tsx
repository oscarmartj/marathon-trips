import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DashboardView } from '@mt/shared';
import { DashboardSections } from '@/components/admin/dashboard/dashboard-panel';
import { presentSections } from '@/lib/dashboard-panel';
import { messageCatalogue } from '@/lib/i18n';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const full: DashboardView = {
  today: '2026-11-13',
  generatedAt: '2026-11-13T04:00:00.000Z',
  sections: {
    newRequests: { total: 3, items: [{ id: 'b1', reference: 'MT-4YRAQQ', requestedAt: '2026-11-12T00:00:00.000Z', requestExpiresAt: '2026-11-19T00:00:00.000Z', raceName: 'Fremantle Run', year: 2027, packageName: 'Race weekend' }] },
    pendingPayments: {
      overdue: 1, dueSoon: 2, horizonDays: 14, truncated: false,
      items: [
        { bookingId: 'b2', reference: 'MT-4YRAQR', kind: 'balance', sequence: 2, dueDate: '2026-11-10', amountDueMinor: '98765', currency: 'AUD', overdue: true },
        { bookingId: 'b3', reference: 'MT-4YRAQS', kind: 'deposit', sequence: 1, dueDate: '2026-11-20', amountDueMinor: '100000', currency: 'AUD', overdue: false },
      ],
    },
    tasks: { overdue: 1, dueSoon: 2, items: [{ id: 't1', title: 'Chase the hotel', dueAt: '2026-11-12T00:00:00.000Z', overdue: true }] },
    stock: { lowCount: 2, items: [{ id: 'p1', kind: 'entry', label: 'Marathon entries', capacity: 40, remaining: 0, lowStock: true, editionId: 'e1', year: 2027, raceName: 'Fremantle Run' }, { id: 'p2', kind: 'room', label: 'Twin rooms', capacity: 20, remaining: 3, lowStock: true, editionId: 'e1', year: 2027, raceName: 'Fremantle Run' }] },
    subscribers: { confirmed: 40, pending: 5, races: [{ raceId: 'r1', slug: 'fremantle', raceName: 'Fremantle Run', confirmed: 40, pending: 5 }] },
  },
};

describe('the staff start page', () => {
  it('shows the counts and lists the API sent, with links into the panel', () => {
    const html = renderToStaticMarkup(<DashboardSections view={full} />);
    const t = text(html);
    expect(t).toContain('Requests waiting for an answer: 3.');
    expect(t).toContain('Overdue: 1. Falling due in the next 14 days: 2.');
    expect(t).toContain('Pools that are low or sold out: 2.');
    expect(t).toContain('Confirmed: 40. Waiting to confirm: 5.');
    expect(t).toContain('Fremantle Run 2027: Race weekend');
    for (const href of ['/admin/bookings/b1', '/admin/bookings/b2', '/admin/editions/e1', '/admin/races/r1', '/admin/tasks']) expect(html).toContain(`href="${href}"`);
  });

  it('shows amounts exactly as the API stated them, never added up', () => {
    const t = text(renderToStaticMarkup(<DashboardSections view={full} />));
    expect(t).toContain('AUD 987.65');
    expect(t).toContain('AUD 1,000.00');
    expect(t).not.toContain('AUD 1,987.65');
  });

  it('marks overdue and sold out in words, not only by colour', () => {
    const t = text(renderToStaticMarkup(<DashboardSections view={full} />));
    expect(t).toContain('Overdue');
    expect(t).toContain('Sold out');
    expect(t).toContain('Low');
    expect(t).toContain('3 of 20');
  });

  it('has one h2 per section, a caption on every table and column headers with a scope', () => {
    const html = renderToStaticMarkup(<DashboardSections view={full} />);
    expect(html.match(/<h2/g)).toHaveLength(5);
    expect(html.match(/<table/g)).toHaveLength(5);
    expect(html.match(/<caption>/g)).toHaveLength(5);
    expect(html).not.toMatch(/<th>/);
    expect(html).toMatch(/<section aria-labelledby="dash-requests-title"/);
  });

  it('leaves out the sections the API left out, and says so when there are none', () => {
    const onlyTasks: DashboardView = { ...full, sections: { tasks: full.sections.tasks } };
    expect(presentSections(onlyTasks)).toEqual(['tasks']);
    const t = text(renderToStaticMarkup(<DashboardSections view={onlyTasks} />));
    expect(t).toContain('Tasks due');
    expect(t).not.toContain('Payments to collect');
    const none = text(renderToStaticMarkup(<DashboardSections view={{ ...full, sections: {} }} />));
    expect(none).toContain('Your role does not include any start page sections');
  });

  it('summaries are plain text: no live regions that a screen reader would announce on every load', () => {
    expect(renderToStaticMarkup(<DashboardSections view={full} />)).not.toContain('role="status"');
  });

  it('empty lists show the summary only, with no empty table', () => {
    const html = renderToStaticMarkup(<DashboardSections view={{ ...full, sections: { newRequests: { total: 0, items: [] }, subscribers: { confirmed: 0, pending: 0, races: [] } } }} />);
    expect(text(html)).toContain('Requests waiting for an answer: 0.');
    expect(html).not.toContain('<table');
  });

  it('every message the page uses exists', () => {
    const cat = messageCatalogue() as { admin: { dashboard: Record<string, unknown> } };
    expect(Object.keys(cat.admin.dashboard).sort()).toEqual(['intro', 'nothingToShow', 'payments', 'requests', 'stock', 'subscribers', 'tasks', 'title']);
  });
});
