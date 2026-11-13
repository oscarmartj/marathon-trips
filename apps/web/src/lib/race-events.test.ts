import { describe, expect, it, vi } from 'vitest';
import { raceEventSchema } from '@mt/shared';
import { sendRaceEvent } from './race-events';

const ok = () => vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('sendRaceEvent', () => {
  it('sends a slug and a kind the API accepts, with no credentials', async () => {
    const send = ok();
    await sendRaceEvent('polar-circle-marathon', 'view', null, send);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = (send as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/analytics/race-events');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', keepalive: true });
    expect(raceEventSchema.safeParse(JSON.parse(String(init.body))).success).toBe(true);
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(['kind', 'raceSlug']);
  });

  it('sends nothing when the browser asks not to be tracked', async () => {
    const send = ok();
    await sendRaceEvent('polar', 'builder', '1', send);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores a failed call, whether it throws or rejects', async () => {
    await expect(sendRaceEvent('polar', 'builder', null, vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).resolves.toBeUndefined();
    await expect(sendRaceEvent('polar', 'view', null, vi.fn(() => { throw new Error('sync'); }) as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
