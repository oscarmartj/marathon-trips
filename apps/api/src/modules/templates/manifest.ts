import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action>. Editing a draft and putting it into use are separate, so a helper can
// draft wording without changing what customers receive. None is an API key scope: wording sent to customers is not
// something an integration should change.
export const TEMPLATES_PERMISSIONS = {
  read: 'templates.template.read',
  manage: 'templates.template.manage',
  publish: 'templates.template.publish',
} as const;

const def = (key: string, description: string): PermissionDef => ({ key, module: 'templates', description, requiresStepUp: false, apiKeyScopable: false });

export const templatesManifest = {
  key: 'templates',
  /** templates is a core module with no feature flag: booking emails read it (plan 0.1, 3.2). */
  flagKey: null,
  permissions: [
    def(TEMPLATES_PERMISSIONS.read, 'See email and document templates, drafts included, and preview them with sample data'),
    def(TEMPLATES_PERMISSIONS.manage, 'Create and edit draft email and document templates'),
    def(TEMPLATES_PERMISSIONS.publish, 'Put a template into use, or take it out of use'),
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;
