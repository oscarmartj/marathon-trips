import { z } from 'zod';
import { MAX_COMPLAINT_DEADLINE_DAYS } from '@mt/shared';
import type { SettingsService } from '../../platform/flags/flags.service';
import type { DeadlineSettings } from './deadlines';

// Deadlines for a new complaint, in calendar days from the day it arrived. Changing a setting never moves the dates of
// complaints already logged.
export const COMPLAINT_SETTINGS = {
  acknowledgeDays: { key: 'complaintAcknowledgeDays', fallback: 2, schema: z.number().int().min(1).max(MAX_COMPLAINT_DEADLINE_DAYS), description: 'Calendar days to acknowledge a complaint, counted from the day it arrived' },
  resolveDays: { key: 'complaintResolveDays', fallback: 30, schema: z.number().int().min(1).max(MAX_COMPLAINT_DEADLINE_DAYS), description: 'Calendar days to resolve a complaint, counted from the day it arrived' },
} as const;

export function defineComplaintSettings(settings: SettingsService): void {
  for (const s of Object.values(COMPLAINT_SETTINGS)) settings.define(s.key, s.schema, 1, { description: s.description });
}

export async function readDeadlineSettings(settings: SettingsService): Promise<DeadlineSettings> {
  return {
    acknowledgeDays: await settings.get(COMPLAINT_SETTINGS.acknowledgeDays.key, COMPLAINT_SETTINGS.acknowledgeDays.fallback),
    resolveDays: await settings.get(COMPLAINT_SETTINGS.resolveDays.key, COMPLAINT_SETTINGS.resolveDays.fallback),
  };
}
