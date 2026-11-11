'use client';

import { DataTable } from './data-table';
import { TaskEditor } from './task-editor';

/** The example table of phase 0: the shared table with the task form as its editor. */
export function TasksTable() {
  return <DataTable entityType="Task" prefix="admin.tasks" editor={(row, saved) => <TaskEditor key={row?.id ?? 'new'} row={row} saved={saved} />} />;
}
