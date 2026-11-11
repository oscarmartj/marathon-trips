'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { t } from '@/lib/i18n';
import { Status } from '../auth/field';
import { errorMessage, useStepUp } from './step-up';

interface Flag {
  key: string;
  description: string;
  enabled: boolean;
}

export function FlagsPanel() {
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, prompt } = useStepUp();

  async function load() {
    const r = await api<Flag[]>('/admin/flags');
    if (r.status === 200) setFlags(r.body as unknown as Flag[]);
    else setError(errorMessage(r));
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(f: Flag) {
    const r = await run(() => api(`/admin/flags/${encodeURIComponent(f.key)}`, { method: 'PUT', body: { enabled: !f.enabled } }));
    if (r.status === 200) await load();
    else setError(errorMessage(r));
  }

  if (!flags) return error ? <Status message={error} /> : <p role="status">{t('admin.common.loading')}</p>;
  return (
    <div className="stack">
      <Status message={error} />
      {prompt}
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('admin.flags.key')}</th>
            <th scope="col">{t('admin.flags.description')}</th>
            <th scope="col">{t('admin.flags.state')}</th>
            <th scope="col">
              <span className="visually-hidden">{t('admin.staff.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {flags.map((f) => (
            <tr key={f.key}>
              <td>
                <code>{f.key}</code>
              </td>
              <td>{f.description}</td>
              <td data-testid={`flag-state-${f.key}`}>{f.enabled ? t('admin.flags.on') : t('admin.flags.off')}</td>
              <td>
                <button className="btn" type="button" onClick={() => toggle(f)}>
                  {f.enabled ? t('admin.flags.turnOff') : t('admin.flags.turnOn')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
