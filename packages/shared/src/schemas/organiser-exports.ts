import { z } from 'zod';

// Organiser exports (task 7.2): runner data in the format a race organiser asks for. Strict objects: an unknown key is a 422.

/** A format id is a code-defined slug, never free text. */
const formatId = z.string().regex(/^[a-z][a-z0-9_]{1,59}$/);

export const organiserExportQuerySchema = z.strictObject({ editionId: z.uuid() });

export const organiserExportBodySchema = z.strictObject({
  editionId: z.uuid(),
  formatId,
  /** Limits the file to one distance of the race. */
  raceDistanceId: z.uuid().optional(),
});

export type OrganiserExportBody = z.infer<typeof organiserExportBodySchema>;

/** A problem with one runner's data for one column of the chosen format. Codes only, never a personal value. */
export const EXPORT_PROBLEM_CODES = ['missing', 'too_long'] as const;
export type ExportProblemCode = (typeof EXPORT_PROBLEM_CODES)[number];

export interface ExportIssue {
  /** The booking reference (random, not personal) and the place in the booking. */
  reference: string;
  slot: number;
  problems: Array<{ column: string; code: ExportProblemCode }>;
}
