import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action>. Editing a draft and putting it on the public site are separate, so a
// helper can write guides without being able to publish them. Legal review has its own permission on purpose.
export const CONTENT_PERMISSIONS = {
  contentRead: 'content.content.read',
  contentManage: 'content.content.manage',
  contentPublish: 'content.content.publish',
  redirectManage: 'content.redirect.manage',
  legalReview: 'content.legal.review',
} as const;

const def = (key: string, description: string): PermissionDef => ({ key, module: 'content', description, requiresStepUp: false });

export const contentManifest = {
  key: 'content',
  /** content is a core module with no feature flag: the public site depends on it for its menu and legal pages. */
  flagKey: null,
  permissions: [
    def(CONTENT_PERMISSIONS.contentRead, 'See every page, guide, FAQ, banner, menu item, redirect and image, drafts included'),
    def(CONTENT_PERMISSIONS.contentManage, 'Create, edit and delete pages, guides, FAQs, banners, menu items and images (as drafts)'),
    def(CONTENT_PERMISSIONS.contentPublish, 'Publish and unpublish pages, guides, FAQs, banners and menu items'),
    def(CONTENT_PERMISSIONS.redirectManage, 'Create, edit, switch off and delete redirects'),
    def(CONTENT_PERMISSIONS.legalReview, 'Mark a legal page as reviewed, or as pending legal review again'),
  ] satisfies PermissionDef[],
  publishes: [] as string[],
  subscribes: [] as string[],
} as const;
