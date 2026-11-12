'use client';

import { type FormEvent, useEffect, useState } from 'react';
import type { TemplateChannelValue } from '@mt/shared';
import { TEMPLATE_CHANNELS } from '@mt/shared';
import { Status } from '../../auth/field';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { type TemplateDefinition, type TemplateRow, actionsFor, createBody, placeholder } from '@/lib/templates-panel';
import { Section, useLoad } from '../catalogue/kit';

interface Preview {
  subject: string | null;
  body: string | null;
  problems: Array<{ field: 'subject' | 'body'; kind: 'unknown_variable' | 'malformed'; name?: string }>;
}

function errorText(r: { status: number; body: { code?: string } }): string {
  try {
    return t(`admin.templates.errors.${r.body?.code ?? ''}`);
  } catch {
    return r.status === 403 ? t('admin.templates.errors.forbidden') : t('admin.catalogue.errors.validation_failed');
  }
}

/**
 * Email and document wording. Staff pick a template, write the wording with {{variables}}, preview it with made-up
 * details and save it as a draft; a draft only goes out once it is put into use.
 */
export function TemplatesPanel() {
  const [channel, setChannel] = useState<TemplateChannelValue>('email');
  const [key, setKey] = useState('');
  const defs = useLoad<{ items: TemplateDefinition[] }>('/admin/templates/definitions');
  const forChannel = defs.data?.items.filter((d) => d.channel === channel) ?? [];
  const def = forChannel.find((d) => { return d.key === key; }) ?? forChannel[0];
  const rows = useLoad<{ items: TemplateRow[] }>(def ? `/admin/templates/${channel}?key=${encodeURIComponent(def.key)}` : null);

  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);

  // A different template starts from its suggested wording.
  useEffect(() => {
    setEditing(null);
    setPreview(null);
    setMessage(null);
    setSubject(def?.starter.subject ?? '');
    setBody(def?.starter.body ?? '');
  }, [def]);

  function edit(row: TemplateRow) {
    setEditing(row);
    setSubject(row.subject);
    setBody(row.body);
    setPreview(null);
    setMessage(null);
  }

  async function runPreview() {
    if (!def) return;
    const r = await api<Preview>(`/admin/templates/${channel}/preview`, { method: 'POST', body: { key: def.key, subject: subject.trim(), body } });
    if (r.status === 200) {
      setPreview(r.body as unknown as Preview);
      setMessage(null);
    } else setMessage({ text: errorText(r), tone: 'error' });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!def) return;
    const r = editing
      ? await api<TemplateRow>(`/admin/templates/${channel}/${editing.id}`, { method: 'PATCH', body: { version: editing.version, subject: subject.trim(), body } })
      : await api<TemplateRow>(`/admin/templates/${channel}`, { method: 'POST', body: createBody(def.key, subject, body) });
    if (r.status === 200 || r.status === 201) {
      const row = r.body as unknown as TemplateRow;
      setEditing(row);
      setMessage({ text: editing ? t('admin.templates.updated') : t('admin.templates.saved', { revision: row.revision }), tone: 'info' });
      await rows.reload();
    } else setMessage({ text: errorText(r), tone: 'error' });
  }

  async function change(row: TemplateRow, action: 'activate' | 'archive') {
    const r = await api<TemplateRow>(`/admin/templates/${channel}/${row.id}/${action}`, { method: 'POST', body: { version: row.version } });
    if (r.status === 200) {
      setMessage({ text: t(action === 'activate' ? 'admin.templates.activated' : 'admin.templates.archived', { revision: row.revision }), tone: 'info' });
      if (editing?.id === row.id) setEditing(null);
      await rows.reload();
    } else setMessage({ text: errorText(r), tone: 'error' });
  }

  const subjectLabel = t(channel === 'email' ? 'admin.templates.subjectEmail' : 'admin.templates.subjectDocument');
  return (
    <div className="stack">
      <Status message={defs.error} />
      <div className="field">
        <label htmlFor="tpl-channel">{t('admin.templates.channel')}</label>
        <select id="tpl-channel" value={channel} onChange={(e) => { setChannel(e.target.value as TemplateChannelValue); setKey(''); }}>
          {TEMPLATE_CHANNELS.map((c) => (
            <option key={c} value={c}>{t(`admin.templates.channels.${c}`)}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="tpl-key">{t('admin.templates.template')}</label>
        <select id="tpl-key" value={def?.key ?? ''} onChange={(e) => setKey(e.target.value)}>
          {forChannel.map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
      </div>

      {def ? (
        <>
          <Section id="tpl-vars" title={t('admin.templates.variablesTitle')}>
            <p>{t('admin.templates.variablesHelp', { example: placeholder(def.variables[0]?.name ?? 'name') })}</p>
            <ul>
              {def.variables.map((v) => (
                <li key={v.name}><code>{placeholder(v.name)}</code>: {v.description}</li>
              ))}
            </ul>
          </Section>

          <Section id="tpl-editor" title={t('admin.templates.editorTitle')}>
            <form className="form stack" onSubmit={save}>
              {editing ? <p role="note">{t('admin.templates.editing', { revision: editing.revision })}</p> : null}
              <div className="field">
                <label htmlFor="tpl-subject">{subjectLabel}</label>
                <input id="tpl-subject" type="text" maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="tpl-body">{t('admin.templates.body')}</label>
                <textarea id="tpl-body" rows={14} maxLength={20000} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
              <div className="actions">
                <button className="btn" type="submit">{editing ? t('admin.templates.saveDraft') : t('admin.templates.newDraft')}</button>
                <button className="btn btn--secondary" type="button" onClick={() => void runPreview()}>{t('admin.templates.preview')}</button>
                <button className="btn btn--secondary" type="button" onClick={() => { setSubject(def.starter.subject); setBody(def.starter.body); }}>{t('admin.templates.useStarter')}</button>
                {editing ? <button className="btn btn--secondary" type="button" onClick={() => setEditing(null)}>{t('admin.templates.stopEditing')}</button> : null}
              </div>
              {message ? <Status message={message.text} tone={message.tone} /> : null}
            </form>
          </Section>

          {preview ? (
            <Section id="tpl-preview" title={t('admin.templates.previewTitle')}>
              <p className="field__hint">{t('admin.templates.previewNote')}</p>
              {preview.problems.length > 0 ? (
                <div role="alert" className="form-error">
                  <p>{t('admin.templates.problems')}</p>
                  <ul>
                    {preview.problems.map((p, i) => (
                      <li key={i}>
                        {p.kind === 'unknown_variable'
                          ? t('admin.templates.problemUnknown', { field: t(p.field === 'subject' ? (channel === 'email' ? 'admin.templates.fieldSubject' : 'admin.templates.fieldTitle') : 'admin.templates.fieldBody'), name: p.name ?? '' })
                          : t('admin.templates.problemMalformed', { field: t(p.field === 'subject' ? (channel === 'email' ? 'admin.templates.fieldSubject' : 'admin.templates.fieldTitle') : 'admin.templates.fieldBody') })}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="stack">
                  <p><strong>{t(channel === 'email' ? 'admin.templates.previewSubject' : 'admin.templates.previewDocumentTitle', { subject: preview.subject ?? '' })}</strong></p>
                  <pre className="preview-text">{preview.body}</pre>
                </div>
              )}
            </Section>
          ) : null}

          <Section id="tpl-revisions" title={t('admin.templates.revisionsTitle')}>
            {rows.data && rows.data.items.length === 0 ? <p role="status">{t('admin.templates.noRevisions')}</p> : null}
            {rows.data && rows.data.items.length > 0 ? (
              <table className="table">
                <caption>{t('admin.templates.revisionsCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('admin.templates.columns.revision')}</th>
                    <th scope="col">{t('admin.templates.columns.language')}</th>
                    <th scope="col">{t('admin.templates.columns.status')}</th>
                    <th scope="col">{t('admin.templates.columns.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.data.items.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.revision}</th>
                      <td>{row.locale}</td>
                      <td>{t(`admin.templates.status.${row.status}`)}</td>
                      <td>
                        <div className="actions">
                          {actionsFor(row).map((a) => {
                            if (a === 'pdf') return <a key={a} className="btn btn--secondary" href={`/api/admin/templates/document/${row.id}/pdf`} target="_blank" rel="noreferrer">{t('admin.templates.pdf')}</a>;
                            return <button key={a} className="btn btn--secondary" type="button" onClick={() => (a === 'edit' ? edit(row) : void change(row, a))}>{t(`admin.templates.${a}`)}</button>;
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <Status message={rows.error} />
          </Section>
        </>
      ) : (
        <p role="status">{t('admin.common.loading')}</p>
      )}
    </div>
  );
}
