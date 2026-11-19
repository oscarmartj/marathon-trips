import type { PermissionDef } from '../../platform/access/permissions';

// Permissions follow <module>.<resource>.<action> (plan 0.1, 1.5). Publishing prices and changing rules or codes, which
// change totals just the same, need a recent TOTP check (plan 2.2, sections 3 and 4).
export const PRICING_PERMISSIONS = {
  versionRead: 'pricing.priceVersion.read',
  versionManage: 'pricing.priceVersion.manage',
  versionPublish: 'pricing.priceVersion.publish',
  quotePreview: 'pricing.quote.preview',
  ruleRead: 'pricing.rule.read',
  ruleManage: 'pricing.rule.manage',
  promoCodeRead: 'pricing.promoCode.read',
  promoCodeManage: 'pricing.promoCode.manage',
  /** Task 6.4: cancellation policies and which one each package sells under. */
  cancellationPolicyRead: 'pricing.cancellationPolicy.read',
  cancellationPolicyManage: 'pricing.cancellationPolicy.manage',
  cancellationPolicyPublish: 'pricing.cancellationPolicy.publish',
} as const;

const def = (key: string, description: string, requiresStepUp = false): PermissionDef => ({ key, module: 'pricing', description, requiresStepUp });

export const pricingManifest = {
  key: 'pricing',
  /** pricing has no feature flag: it cannot be switched off (plan 0.1, 3.1). */
  flagKey: null,
  permissions: [
    { ...def(PRICING_PERMISSIONS.versionRead, 'See price versions and their rates, drafts included'), apiKeyScopable: true },
    def(PRICING_PERMISSIONS.versionManage, 'Create, edit and discard draft price versions'),
    def(PRICING_PERMISSIONS.versionPublish, 'Publish or schedule a price version, which replaces the prices in force, or withdraw a scheduled one', true),
    { ...def(PRICING_PERMISSIONS.quotePreview, 'Price any package or draft version in the panel, with the reasons behind each rule'), apiKeyScopable: true },
    def(PRICING_PERMISSIONS.ruleRead, 'See price rules (early bird, supplements, group discounts), archived ones included'),
    def(PRICING_PERMISSIONS.ruleManage, 'Create, change and archive price rules, which change totals at once', true),
    def(PRICING_PERMISSIONS.promoCodeRead, 'See promo codes and how often they have been used'),
    def(PRICING_PERMISSIONS.promoCodeManage, 'Create, change and archive promo codes', true),
    def(PRICING_PERMISSIONS.cancellationPolicyRead, 'See cancellation policies and their tiers, drafts included'),
    def(PRICING_PERMISSIONS.cancellationPolicyManage, 'Create, edit, duplicate and delete draft cancellation policies'),
    // Activating freezes terms customers are bound by; assigning decides what new bookings are sold under (task 6.4).
    def(PRICING_PERMISSIONS.cancellationPolicyPublish, 'Activate or archive a cancellation policy, or change the one a package sells under', true),
  ] satisfies PermissionDef[],
  publishes: ['pricing.price_version.published', 'pricing.price_version.withdrawn'],
  subscribes: [] as string[],
} as const;
