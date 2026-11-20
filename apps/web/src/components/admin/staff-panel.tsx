'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n-admin';
import { Field, Status } from '../auth/field';
import { errorMessage, useStepUp } from './step-up';

interface Staff {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  enrolled: boolean;
  roleKeys: string[];
}

const keysFrom = (v: FormDataEntryValue | null) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function StaffPanel() {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const { run, prompt } = useStepUp();

  async function load() {
    const r = await api<Staff[]>('/admin/staff');
    if (r.status === 200) setStaff(r.body as unknown as Staff[]);
    else setError(errorMessage(r));
  }
  useEffect(() => {
    void load();
  }, []);

  async function act(path: string, body: object, showLink = false) {
    setLink(null);
    const r = await run(() => api(path, { method: path.endsWith('/roles') ? 'PATCH' : 'POST', body }));
    if (r.status >= 200 && r.status < 300) {
      setError(null);
      if (showLink) setLink(String((r.body as { enrolmentUrl?: string }).enrolmentUrl ?? ''));
      await load();
    } else setError(errorMessage(r));
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await act('/admin/staff', { email: form.get('email'), roleKeys: keysFrom(form.get('roleKeys')) }, true);
  }

  return (
    <div className="stack">
      <Status message={error} />
      {prompt}
      {link ? (
        <div className="notice stack" role="status">
          <p>{t('admin.staff.linkCreated')}</p>
          <code className="secret">{link}</code>
        </div>
      ) : null}
      {!staff ? (
        <p role="status">{t('admin.common.loading')}</p>
      ) : staff.length === 0 ? (
        <p>{t('admin.staff.none')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t('admin.staff.email')}</th>
              <th scope="col">{t('admin.staff.roles')}</th>
              <th scope="col">{t('admin.staff.status')}</th>
              <th scope="col">{t('admin.staff.setUp')}</th>
              <th scope="col">{t('admin.staff.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id}>
                <td>{s.email}</td>
                <td>
                  <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act(`/admin/staff/${s.id}/roles`, { roleKeys: keysFrom(new FormData(e.currentTarget).get('roleKeys')) }); }}>
                    <Field label={t('admin.staff.rolesHelp')} id={`roles-${s.id}`} name="roleKeys" defaultValue={s.roleKeys.join(', ')} />
                    <button className="btn" type="submit">{t('admin.staff.saveRoles')}</button>
                  </form>
                </td>
                <td>{s.status === 'active' ? t('admin.staff.active') : t('admin.staff.disabled')}</td>
                <td>{s.enrolled ? t('admin.staff.enrolled') : t('admin.staff.notEnrolled')}</td>
                <td className="actions">
                  <button className="btn" type="button" onClick={() => act(`/admin/staff/${s.id}/${s.status === 'active' ? 'disable' : 'enable'}`, {})}>
                    {s.status === 'active' ? t('admin.staff.disable') : t('admin.staff.enable')}
                  </button>
                  <button className="btn" type="button" onClick={() => act(`/admin/staff/${s.id}/reset-enrolment`, {}, true)}>
                    {t('admin.staff.reset')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="card stack form" onSubmit={add} aria-labelledby="add-staff">
        <h2 id="add-staff">{t('admin.staff.add')}</h2>
        <Field label={t('admin.staff.email')} id="email" type="email" required />
        <Field label={t('admin.staff.rolesHelp')} id="roleKeys" />
        <button className="btn" type="submit">{t('admin.staff.addButton')}</button>
      </form>
    </div>
  );
}
