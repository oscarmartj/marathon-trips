'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Field, Status } from '../auth/field';
import { errorMessage, useStepUp } from './step-up';

interface Role {
  key: string;
  name: string;
  isSystem: boolean;
  version: number;
  permissionKeys: string[];
}
interface Permission {
  key: string;
  description: string;
  requiresStepUp: boolean;
}

/** The permission matrix: one column per role, one checkbox per permission. */
export function RolesPanel() {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const { run, prompt } = useStepUp();

  async function load() {
    const [r, p] = await Promise.all([api<Role[]>('/admin/roles'), api<Permission[]>('/admin/permissions')]);
    if (r.status === 200 && p.status === 200) {
      setRoles(r.body as unknown as Role[]);
      setPermissions(p.body as unknown as Permission[]);
    } else setError(errorMessage(r.status === 200 ? p : r));
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(role: Role, form: HTMLFormElement) {
    const data = new FormData(form);
    const permissionKeys = permissions.map((p) => p.key).filter((k) => data.get(k) === 'on');
    const r = await run(() => api(`/admin/roles/${role.key}/permissions`, { method: 'PUT', body: { permissionKeys, version: role.version } }));
    if (r.status === 200) {
      setError(null);
      setInfo(t('admin.roles.saved'));
      await load();
    } else setError(errorMessage(r));
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const r = await run(() => api('/admin/roles', { method: 'POST', body: { key: form.get('key'), name: form.get('name') } }));
    if (r.status === 201) await load();
    else setError(errorMessage(r));
  }

  if (!roles) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  return (
    <div className="stack">
      <Status message={error} />
      <Status tone="info" message={info} />
      {prompt}
      <p>{t('admin.roles.ownerNote')}</p>
      {roles.filter((r) => !r.isSystem).map((role) => (
        <form key={role.key} className="card stack" onSubmit={(e) => { e.preventDefault(); void save(role, e.currentTarget); }}>
          <h2>{role.name}</h2>
          <fieldset>
            <legend className="visually-hidden">{role.name}</legend>
            {permissions.map((p) => (
              <div key={p.key} className="check">
                <input type="checkbox" id={`${role.key}-${p.key}`} name={p.key} defaultChecked={role.permissionKeys.includes(p.key)} />
                <label htmlFor={`${role.key}-${p.key}`}>
                  {p.description} <code>{p.key}</code>
                  {p.requiresStepUp ? <span className="tag">{t('admin.roles.stepUp')}</span> : null}
                </label>
              </div>
            ))}
          </fieldset>
          <button className="btn" type="submit">{t('admin.roles.save', { role: role.name })}</button>
        </form>
      ))}
      <form className="card stack form" onSubmit={create} aria-labelledby="create-role">
        <h2 id="create-role">{t('admin.roles.create')}</h2>
        <Field label={t('admin.roles.key')} id="key" pattern="[a-z][a-z0-9_]{1,39}" required />
        <Field label={t('admin.roles.name')} id="name" required />
        <button className="btn" type="submit">{t('admin.roles.createButton')}</button>
      </form>
    </div>
  );
}
