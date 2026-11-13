/**
 * The anonymous visit counter's browser side (task 7.7): a slug and a kind, nothing else, never any credentials, and
 * nothing at all when the browser asks not to be tracked. A failure is ignored: a missed count matters less than a slow page.
 */
export type RaceEventKind = 'view' | 'builder';

export async function sendRaceEvent(raceSlug: string, kind: RaceEventKind, doNotTrack: string | null | undefined, send: typeof fetch = fetch): Promise<void> {
  if (doNotTrack === '1') return;
  try {
    await send('/api/analytics/race-events', {
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-MT-CSRF': '1' },
      body: JSON.stringify({ raceSlug, kind }),
    });
  } catch {
    /* a missed count is fine */
  }
}
