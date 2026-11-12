import { z } from 'zod';
import { MAX_QUOTE_VALIDITY_DAYS } from '@mt/shared';
import type { SettingsService } from '../../platform/flags/flags.service';

export const CRM_SETTINGS = {
  quoteValidityDays: { key: 'quoteValidityDays', fallback: 14, schema: z.number().int().min(1).max(MAX_QUOTE_VALIDITY_DAYS), description: 'Days a quote can be accepted once it is sent (never past the start of the departure day)' },
} as const;

export function defineCrmSettings(settings: SettingsService): void {
  for (const s of Object.values(CRM_SETTINGS)) settings.define(s.key, s.schema, 1, { description: s.description });
}
