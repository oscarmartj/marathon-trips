import type { PermissionDef } from '../access/permissions';

export const COMMON_PERMISSIONS_KEYS = {
  tableUse: 'common.table.use',
  tagManage: 'common.tag.manage',
  viewManage: 'common.view.manage',
  taskRead: 'common.task.read',
  taskWrite: 'common.task.write',
  taskDelete: 'common.task.delete',
  taskExport: 'common.task.export',
  taskImport: 'common.task.import',
  taskManageAutomated: 'common.task.manageAutomated',
  customFieldRead: 'common.customField.read',
  customFieldManage: 'common.customField.manage',
} as const;
const K = COMMON_PERMISSIONS_KEYS;

export const COMMON_PERMISSIONS: readonly PermissionDef[] = [
  { key: K.tableUse, module: 'common', description: 'Use the shared table tools (search, views, tags, notes); each table still needs its own permissions', apiKeyScopable: true },
  { key: K.tagManage, module: 'common', description: 'Create, rename, recolour and delete tags' },
  { key: K.viewManage, module: 'common', description: 'Share saved table views with other staff and manage shared views' },
  { key: K.taskRead, module: 'common', description: 'See tasks', apiKeyScopable: true },
  { key: K.taskWrite, module: 'common', description: 'Create and change manual tasks', apiKeyScopable: true },
  { key: K.taskDelete, module: 'common', description: 'Delete and restore tasks' },
  { key: K.taskExport, module: 'common', description: 'Export tasks to CSV' },
  { key: K.taskImport, module: 'common', description: 'Import tasks from CSV' },
  { key: K.taskManageAutomated, module: 'common', description: 'Change, close and delete tasks created by automation or the system' },
  { key: K.customFieldRead, module: 'common', description: 'See custom field definitions, so their fields appear on forms, filters and exports' },
  { key: K.customFieldManage, module: 'common', description: 'Create, change, archive and restore custom field definitions' },
];
