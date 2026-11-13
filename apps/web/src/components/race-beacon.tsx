'use client';

import { useEffect } from 'react';
import { type RaceEventKind, sendRaceEvent } from '@/lib/race-events';

/** Counts one anonymous visit to a race (task 7.7), once per page view. It renders nothing. */
export function RaceBeacon({ raceSlug, kind }: { raceSlug: string; kind: RaceEventKind }) {
  useEffect(() => {
    void sendRaceEvent(raceSlug, kind, navigator.doNotTrack);
  }, [raceSlug, kind]);
  return null;
}
