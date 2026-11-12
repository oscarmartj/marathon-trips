'use client';

import { api } from '@/lib/api-client';
import { enAU, wholeNumber, withOptionalEnAU } from '@/lib/catalogue-panel';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { ActionButton, EntityForm, type FieldDef, Section, outcome, useLoad } from './kit';

interface Hotel {
  id: string;
  name: string;
  address: string;
  city: string;
  countryCode: string;
  starRating: number | null;
  description: unknown;
  version: number;
  isDemo: boolean;
}

const fields = (): FieldDef[] => [
  { key: 'name', label: t('admin.catalogue.hotels.fields.name'), type: 'text', required: true, maxLength: 150 },
  { key: 'address', label: t('admin.catalogue.hotels.fields.address'), type: 'text', required: true, maxLength: 300 },
  { key: 'city', label: t('admin.catalogue.hotels.fields.city'), type: 'text', required: true, maxLength: 100 },
  { key: 'countryCode', label: t('admin.catalogue.races.fields.countryCode'), type: 'text', required: true, maxLength: 2, hint: t('admin.catalogue.races.fields.countryHint') },
  {
    key: 'starRating', label: t('admin.catalogue.hotels.fields.starRating'), type: 'select',
    options: [{ value: '', label: t('admin.catalogue.common.notSet') }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: t('admin.catalogue.hotels.stars', { count: n }) }))],
  },
  { key: 'description', label: t('admin.catalogue.hotels.fields.description'), type: 'textarea', maxLength: 2000 },
];

const body = (v: Record<string, string | boolean>, previous?: unknown) => ({
  name: String(v.name).trim(), address: String(v.address).trim(), city: String(v.city).trim(), countryCode: String(v.countryCode).trim().toUpperCase(),
  starRating: wholeNumber(String(v.starRating)) ?? null, description: withOptionalEnAU(previous, String(v.description)),
});

/** Hotels: list, create, edit and delete (a hotel that is part of a package cannot be deleted). */
export function HotelsPanel() {
  const { data, error, reload } = useLoad<Hotel[]>('/admin/catalogue/hotels');
  return (
    <div className="stack">
      <Section id="hotels-list" title={t('admin.catalogue.hotels.listTitle')}>
        <Status message={error} />
        {data ? (
          data.length === 0 ? (
            <p role="status">{t('admin.catalogue.hotels.empty')}</p>
          ) : (
            <ul className="stack">
              {data.map((h) => (
                <li key={`${h.id}-${h.version}`} className="stack">
                  <strong>{h.name}</strong> {h.isDemo ? <span className="badge">{t('admin.catalogue.common.demo')}</span> : null}
                  <span>{t('admin.catalogue.hotels.where', { city: h.city, country: h.countryCode })}</span>
                  <details>
                    <summary>{t('admin.catalogue.hotels.edit', { name: h.name })}</summary>
                    <EntityForm
                      id={`hotel-${h.id}`}
                      fields={fields()}
                      initial={{ name: h.name, address: h.address, city: h.city, countryCode: h.countryCode, starRating: h.starRating === null ? '' : String(h.starRating), description: enAU(h.description) }}
                      submit={t('admin.catalogue.common.save')}
                      onSubmit={async (v) => {
                        const out = await outcome(() => api(`/admin/catalogue/hotels/${h.id}`, { method: 'PATCH', body: { ...body(v, h.description), version: h.version } }), t('admin.catalogue.common.saved'));
                        if (out.ok) void reload();
                        return out;
                      }}
                    />
                    <ActionButton danger text={t('admin.catalogue.hotels.delete')} run={() => api(`/admin/catalogue/hotels/${h.id}`, { method: 'DELETE' })} onDone={() => void reload()} />
                  </details>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p role="status">{t('admin.common.loading')}</p>
        )}
      </Section>
      <Section id="hotels-new" title={t('admin.catalogue.hotels.newTitle')}>
        <EntityForm
          id="new-hotel"
          fields={fields()}
          initial={{ name: '', address: '', city: '', countryCode: 'AU', starRating: '', description: '' }}
          submit={t('admin.catalogue.hotels.create')}
          resetOnSuccess
          onSubmit={async (v) => {
            const out = await outcome(() => api('/admin/catalogue/hotels', { method: 'POST', body: body(v) }), t('admin.catalogue.hotels.created'));
            if (out.ok) void reload();
            return out;
          }}
        />
      </Section>
    </div>
  );
}
