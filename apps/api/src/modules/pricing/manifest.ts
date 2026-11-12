import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action> (plan 0.1, 1.5). Publishing prices needs a recent TOTP check.
export const PRICING_PERMISSIONS = {
  versionRead: 'pricing.priceVersion.read',
  versionManage: 'pricing.priceVersion.manage',
  versionPublish: 'pricing.priceVersion.publish',
  quotePreview: 'pricing.quote.preview',
} as const;

const def = (key: string, description: string, requiresStepUp = false): PermissionDef => ({ key, module: 'pricing', description, requiresStepUp });

export const pricingManifest = {
  key: 'pricing',
  /** pricing has no feature flag: it cannot be switched off (plan 0.1, 3.1). */
  flagKey: null,
  permissions: [
    { ...def(PRICING_PERMISSIONS.versionRead, 'See price versions and their rates, drafts included'), apiKeyScopable: true },
    def(PRICING_PERMISSIONS.versionManage, 'Create, edit and discard draft price versions'),
    def(PRICING_PERMISSIONS.versionPublish, 'Publish a price version, which replaces the prices in force', true),
    { ...def(PRICING_PERMISSIONS.quotePreview, 'Price any package or draft version in the panel, with the reasons behind each rule'), apiKeyScopable: true },
  ] satisfies PermissionDef[],
  publishes: ['pricing.price_version.published'],
  subscribes: [] as string[],
} as const;
