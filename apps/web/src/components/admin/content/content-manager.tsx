'use client';

import Link from 'next/link';
import { useState } from 'react';
import { BANNER_TONES, MENU_LOCATIONS, PAGE_KINDS, REDIRECT_CODES } from '@mt/shared';
import { api } from '@/lib/api-client';
import { type AdminKind, CREATE_ONLY, HAS_STATUS, type Row, contentBody, contentInitial, publicPath } from '@/lib/content-admin';
import { t } from '@/lib/i18n';
import { Status } from '../../auth/field';
import { ActionButton, EntityForm, type FieldDef, Section, formatDay, label, outcome, useLoad } from '../catalogue/kit';

interface ListResponse { items: Row[]; total?: number }
interface Option { value: string; label: string }

const keyed = (keys: readonly string[], prefix: string): Option[] => keys.map((k) => ({ value: k, label: t(`${prefix}.${k}`) }));
const f = (key: string, type: FieldDef['type'], more: Partial<FieldDef> = {}): FieldDef => ({ key, type, label: t(`admin.content.fields.${key}`), ...more });

/** The fields of each kind's form. `images` and `races` are the choices for the header image and the race. */
function fieldsFor(kind: AdminKind, images: Option[], races: Option[]): FieldDef[] {
  const noImage = [{ value: '', label: t('admin.content.fields.noImage') }, ...images];
  const locale = f('locale', 'text', { required: true, maxLength: 10, hint: t('admin.content.languageHint') });
  switch (kind) {
    case 'pages':
      return [
        locale,
        f('slug', 'text', { required: true, maxLength: 80, hint: t('admin.content.fields.slugHint') }),
        f('kind', 'select', { required: true, options: keyed(PAGE_KINDS, 'admin.content.kindsLabels.pageKinds'), hint: t('admin.content.legalHint') }),
        f('title', 'text', { required: true, maxLength: 200 }),
        f('intro', 'textarea', { maxLength: 500 }),
        f('body', 'textarea', { maxLength: 50000, hint: t('admin.content.fields.bodyHint') }),
        f('heroMediaId', 'select', { options: noImage }),
        f('seoTitle', 'text', { maxLength: 120 }),
        f('seoDescription', 'textarea', { maxLength: 300 }),
      ];
    case 'guides':
      return [
        f('raceId', 'select', { required: true, options: [{ value: '', label: t('admin.content.fields.chooseRace') }, ...races] }),
        locale,
        f('course', 'textarea', { maxLength: 20000, hint: t('admin.content.fields.bodyHint') }),
        f('climate', 'textarea', { maxLength: 20000 }),
        f('entry', 'textarea', { maxLength: 20000 }),
        f('travelTips', 'textarea', { maxLength: 20000 }),
        f('heroMediaId', 'select', { options: noImage }),
        f('seoTitle', 'text', { maxLength: 120 }),
        f('seoDescription', 'textarea', { maxLength: 300 }),
      ];
    case 'faqs':
      return [
        locale,
        f('category', 'text', { maxLength: 80, hint: t('admin.content.fields.categoryHint') }),
        f('question', 'text', { required: true, maxLength: 300 }),
        f('answer', 'textarea', { required: true, maxLength: 10000, hint: t('admin.content.fields.bodyHint') }),
        f('sortOrder', 'number', { min: 0, max: 100000, hint: t('admin.content.fields.sortOrderHint') }),
      ];
    case 'banners':
      return [
        locale,
        f('message', 'text', { required: true, maxLength: 300 }),
        f('tone', 'select', { required: true, options: keyed(BANNER_TONES, 'admin.content.kindsLabels.tones') }),
        f('linkLabel', 'text', { maxLength: 60 }),
        f('linkHref', 'text', { maxLength: 500, hint: t('admin.content.fields.linkHint') }),
        f('startsAt', 'datetime-local', { hint: t('admin.content.fields.dateHint') }),
        f('endsAt', 'datetime-local', { hint: t('admin.content.fields.dateHint') }),
      ];
    case 'menu':
      return [
        locale,
        f('location', 'select', { required: true, options: keyed(MENU_LOCATIONS, 'admin.content.kindsLabels.locations') }),
        f('label', 'text', { required: true, maxLength: 60 }),
        f('href', 'text', { required: true, maxLength: 500, hint: t('admin.content.fields.linkHint') }),
        f('sortOrder', 'number', { min: 0, max: 100000, hint: t('admin.content.fields.sortOrderHint') }),
      ];
    case 'media':
      return [
        f('label', 'text', { required: true, maxLength: 150 }),
        f('src', 'text', { required: true, maxLength: 500, hint: t('admin.content.fields.srcHint') }),
        f('altText', 'text', { maxLength: 300 }),
        f('decorative', 'checkbox'),
        f('width', 'number', { min: 1, max: 20000 }),
        f('height', 'number', { min: 1, max: 20000 }),
        f('credit', 'text', { maxLength: 300 }),
      ];
    case 'redirects':
      return [
        f('fromPath', 'text', { required: true, maxLength: 300, hint: t('admin.content.fields.fromHint') }),
        f('toPath', 'text', { required: true, maxLength: 500, hint: t('admin.content.fields.linkHint') }),
        f('statusCode', 'select', { required: true, options: REDIRECT_CODES.map((c) => ({ value: String(c), label: t(`admin.content.kindsLabels.codes.${c}`) })) }),
        f('enabled', 'checkbox'),
      ];
  }
}

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const status = (row: Row): string => t(`admin.content.statuses.${str(row.status) === 'published' ? 'published' : 'draft'}`);

/** One line that says what a row is, for the list and for the buttons' names. */
export function summaryOf(kind: AdminKind, row: Row): string {
  switch (kind) {
    case 'pages': return t('admin.content.summary.page', { slug: str(row.slug), locale: str(row.locale), status: status(row) });
    case 'guides': {
      const race = row.race as { slug?: string } | undefined;
      return t('admin.content.summary.guide', { race: race?.slug ?? str(row.raceId), locale: str(row.locale), status: status(row) });
    }
    case 'faqs': return t('admin.content.summary.faq', { question: str(row.question), status: status(row) });
    case 'banners': return t('admin.content.summary.banner', { message: str(row.message), status: status(row) });
    case 'menu': return t('admin.content.summary.menu', { place: label(`admin.content.kindsLabels.locations.${str(row.location)}`, str(row.location)), label: str(row.label), href: str(row.href), status: status(row) });
    case 'media': return t('admin.content.summary.media', { label: str(row.label) });
    case 'redirects': return t('admin.content.summary.redirect', { from: str(row.fromPath), to: str(row.toPath), code: String(row.statusCode), state: t(`admin.content.enabledState.${row.enabled === true ? 'on' : 'off'}`) });
  }
}

const listPath = (kind: AdminKind): string => `/admin/content/${kind}${kind === 'redirects' ? '' : '?pageSize=200'}`;

/** Lists one kind of content with its actions, an edit form and an add form. The API decides what each person may do. */
export function ContentManager({ kind }: { kind: AdminKind }) {
  const list = useLoad<ListResponse>(listPath(kind));
  const media = useLoad<ListResponse>(kind === 'pages' || kind === 'guides' ? '/admin/content/media?pageSize=200' : null);
  const races = useLoad<ListResponse>(kind === 'guides' ? '/admin/catalogue/races?pageSize=100' : null);
  const [editing, setEditing] = useState<string | null>(null);
  const images = (media.data?.items ?? []).map((m) => ({ value: m.id, label: str(m.label) }));
  const raceOptions = (races.data?.items ?? []).map((r) => ({ value: r.id, label: str(r.slug) }));
  const all = fieldsFor(kind, images, raceOptions);
  const createOnly = CREATE_ONLY[kind];
  const editFields = all.filter((x) => !createOnly.includes(x.key));
  const row = list.data?.items.find((r) => r.id === editing) ?? null;
  const kindName = t(`admin.content.kinds.${kind}`);
  function reload(): void {
    void list.reload();
  }

  return (
    <div className="stack">
      <p>{t(`admin.content.kindHints.${kind}`)}</p>
      <Section id="content-list" title={t('admin.content.listTitle', { kind: kindName })}>
        <Status message={list.error ?? races.error} />
        {!list.data ? (
          <p role="status">{t('admin.content.loading')}</p>
        ) : list.data.items.length === 0 ? (
          <p role="status">{t('admin.content.empty')}</p>
        ) : (
          <ul className="stack">
            {list.data.items.map((r) => {
              const name = summaryOf(kind, r);
              const path = publicPath(kind, r);
              return (
                <li key={r.id} className="stack">
                  <span>
                    {name}
                    {kind === 'pages' && r.kind === 'legal' ? <span className="badge">{r.legalReviewPending === true ? t('admin.content.legalPending') : t('admin.content.legalReviewed')}</span> : null}
                  </span>
                  {path && HAS_STATUS[kind] && r.status === 'published' ? <span className="field__hint">{t('admin.content.previewHint', { path })}</span> : null}
                  {typeof r.updatedAt === 'string' ? <span className="field__hint">{formatDay(r.updatedAt)}</span> : null}
                  <span className="actions">
                    <button type="button" className="btn" aria-expanded={editing === r.id} onClick={() => setEditing(editing === r.id ? null : r.id)}>
                      {editing === r.id ? t('admin.content.close') : t('admin.content.edit')}
                    </button>
                    {HAS_STATUS[kind] ? (
                      <ActionButton
                        text={r.status === 'published' ? t('admin.content.unpublishItem', { name }) : t('admin.content.publishItem', { name })}
                        run={() => api(`/admin/content/${kind}/${r.id}/status`, { method: 'POST', body: { status: r.status === 'published' ? 'draft' : 'published', version: r.version } })}
                        onDone={reload}
                      />
                    ) : null}
                    {kind === 'pages' && r.kind === 'legal' ? (
                      <ActionButton
                        text={r.legalReviewPending === true ? t('admin.content.markReviewed') : t('admin.content.markPending')}
                        run={() => api(`/admin/content/pages/${r.id}/legal-review`, { method: 'POST', body: { pending: r.legalReviewPending !== true, version: r.version } })}
                        onDone={reload}
                      />
                    ) : null}
                    <ActionButton danger text={t('admin.content.deleteItem', { name })} run={() => api(`/admin/content/${kind}/${r.id}`, { method: 'DELETE' })} onDone={() => { if (editing === r.id) setEditing(null); reload(); }} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {row ? (
        <Section id="content-edit" title={t('admin.content.editTitle', { name: summaryOf(kind, row) })}>
          <EntityForm
            key={`${row.id}:${row.version}`}
            id={`edit-${kind}`}
            fields={editFields}
            initial={contentInitial(kind, row)}
            submit={t('admin.content.save')}
            onSubmit={async (v) => {
              const out = await outcome(() => api(`/admin/content/${kind}/${row.id}`, { method: 'PATCH', body: { ...contentBody(kind, v, 'update'), version: row.version } }), t('admin.content.saved'));
              if (out.ok) reload();
              return out;
            }}
          />
        </Section>
      ) : null}
      <Section id="content-new" title={t('admin.content.newTitle')}>
        <EntityForm
          id={`new-${kind}`}
          fields={all}
          initial={contentInitial(kind)}
          submit={t('admin.content.create')}
          resetOnSuccess
          onSubmit={async (v) => {
            const out = await outcome(() => api(`/admin/content/${kind}`, { method: 'POST', body: contentBody(kind, v, 'create') }), t('admin.content.created'));
            if (out.ok) reload();
            return out;
          }}
        />
      </Section>
    </div>
  );
}

/** The overview: one link per kind of content. */
export function ContentOverview({ kinds }: { kinds: readonly AdminKind[] }) {
  return (
    <ul className="stack">
      {kinds.map((k) => (
        <li key={k} className="card stack">
          <h2><Link href={`/admin/content/${k}`}>{t(`admin.content.kinds.${k}`)}</Link></h2>
          <p>{t(`admin.content.kindHints.${k}`)}</p>
        </li>
      ))}
    </ul>
  );
}
