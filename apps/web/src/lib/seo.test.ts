import { describe, expect, it } from 'vitest';
import { detail } from '@/test/catalogue-fixtures';
import { breadcrumbJsonLd, pageMetadata, raceDescription, raceEventsJsonLd, serialiseJsonLd } from './seo';
import { absoluteUrl, siteUrl } from './site';

describe('site address', () => {
  it('comes from WEB_ORIGIN, without a path or trailing slash, and falls back for a bad value', () => {
    const before = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = 'https://trips.example.test/some/path/';
    expect(siteUrl()).toBe('https://trips.example.test');
    expect(absoluteUrl('/races')).toBe('https://trips.example.test/races');
    process.env.WEB_ORIGIN = 'not a url';
    expect(siteUrl()).toBe('http://localhost:3000');
    if (before === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = before;
  });
});

describe('page metadata', () => {
  it('has a canonical address, hreflang entries, Open Graph and a large Twitter card', () => {
    const m = pageMetadata({ title: 'Sample', description: 'About sample', path: '/races/sample' });
    expect(m.alternates?.canonical).toMatch(/\/races\/sample$/);
    expect(Object.keys(m.alternates?.languages ?? {})).toEqual(['en-AU', 'x-default']);
    expect(m.openGraph).toMatchObject({ title: 'Sample', description: 'About sample', locale: 'en_AU' });
    expect(m.twitter).toMatchObject({ card: 'summary_large_image' });
  });
});

describe('structured data', () => {
  it('gives a confirmed edition a SportsEvent with its date and place, and no offer, organiser or accreditation', () => {
    const events = raceEventsJsonLd(detail());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ '@type': 'SportsEvent', name: 'Sample Marathon 2027', startDate: '2027-05-01', eventStatus: 'https://schema.org/EventScheduled' });
    expect(events[0]).toMatchObject({ location: { address: { addressLocality: 'Rotorua', addressCountry: 'NZ' } } });
    const text = JSON.stringify(events);
    for (const word of ['offers', 'organizer', 'official', 'guaranteed', 'accredit']) expect(text.toLowerCase()).not.toContain(word);
  });

  it('leaves out an edition whose date is not confirmed, so a provisional date is never stated as fact', () => {
    const race = detail();
    race.editions = [{ ...race.editions[0]!, dateConfirmed: false, dateStatus: 'provisional' }, { ...race.editions[0]!, year: 2028, startDate: null }];
    expect(raceEventsJsonLd(race)).toEqual([]);
  });

  it('marks a cancelled edition as cancelled', () => {
    const race = detail();
    race.editions = [{ ...race.editions[0]!, status: 'cancelled' }];
    expect(raceEventsJsonLd(race)[0]).toMatchObject({ eventStatus: 'https://schema.org/EventCancelled' });
  });

  it('builds a numbered breadcrumb trail with absolute addresses', () => {
    const ld = breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Races', path: '/races' }]) as { itemListElement: Array<{ position: number; item: string }> };
    expect(ld.itemListElement.map((i) => i.position)).toEqual([1, 2]);
    expect(ld.itemListElement[1]!.item).toMatch(/^https?:\/\/.+\/races$/);
  });

  it('escapes < so catalogue text cannot close the script tag', () => {
    expect(serialiseJsonLd({ name: '</script><script>alert(1)</script>' })).not.toContain('<');
  });

  it('describes a race without a summary from its name and place', () => {
    const d = raceDescription({ ...detail(), summary: {} });
    expect(d).toContain('Sample Marathon');
    expect(d).toContain('Rotorua');
  });
});
