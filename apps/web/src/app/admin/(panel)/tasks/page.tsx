import { AdminPage } from '@/components/admin-page';
import { TasksTable } from '@/components/admin/table/tasks-table';
import { t } from '@/lib/i18n-admin';

export default function Page() {
  return (
    <AdminPage current="/admin/tasks" title={t('admin.tasks.title')} intro={t('admin.tasks.intro')} placeholder={false}>
      <TasksTable />
    </AdminPage>
  );
}
