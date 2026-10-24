import { describe, expect, it } from 'vitest';
import { compactGeometry, groupByZone, plzsOf, streetsOf, type Feature, type PlzAddress, type ZoneShare } from '../../src/geo.js';
import { plzTitle, share, zoneMap } from '../../src/report.js';
import { PlzQuery } from '../../src/schema.js';

// квадрат [x0..x0+1] × [0..1]
const zone = (esb: string, x0: number): Feature => ({
  id: esb,
  properties: { esb },
  geometry: { type: 'Polygon', coordinates: [[[x0, 0], [x0 + 1, 0], [x0 + 1, 1], [x0, 1], [x0, 0]]] },
});
const addr = (street: string, house: number, lon: number, suffix: string | null = null): PlzAddress => ({
  street,
  house,
  suffix,
  lon,
  lat: 0.5,
});

describe('groupByZone', () => {
  const a = zone('0101', 0);
  const b = zone('0102', 1);

  it('groups addresses by the zone they fall into, biggest group first', () => {
    const groups = groupByZone([addr('A', 1, 1.5), addr('A', 2, 0.5), addr('A', 3, 1.2), addr('A', 4, 1.8)], [a, b]);
    expect(groups.map((g) => [g.zone.properties.esb, g.addrs.length])).toEqual([
      ['0102', 3],
      ['0101', 1],
    ]);
  });

  it('address outside every zone is left out; zones without addresses are dropped', () => {
    const groups = groupByZone([addr('A', 1, 0.5), addr('A', 2, 5)], [a, b]);
    expect(groups.map((g) => [g.zone.properties.esb, g.addrs.length])).toEqual([['0101', 1]]);
  });
});

describe('streetsOf', () => {
  it('houses sorted by number then letter, streets alphabetically', () => {
    expect(
      streetsOf([addr('Weimarer Straße', 10, 0), addr('Ackerstraße', 3, 0), addr('Weimarer Straße', 2, 0, 'B'), addr('Weimarer Straße', 2, 0)]),
    ).toEqual([
      { street: 'Ackerstraße', houses: ['3'] },
      { street: 'Weimarer Straße', houses: ['2', '2B', '10'] },
    ]);
  });
});

describe('PlzQuery', () => {
  it.each(['10439', '01234'])('accepts %s', (plz) => {
    expect(PlzQuery.parse({ plz }).plz).toBe(plz);
  });

  it.each(['1043', '104390', 'abcde', undefined])('rejects %s', (plz) => {
    expect(() => PlzQuery.parse({ plz })).toThrow();
  });
});

describe('PlzQuery: Ortsteil', () => {
  it('Ortsteil without PLZ is enough', () => {
    expect(PlzQuery.parse({ ortsteil: 'Friedenau' })).toMatchObject({ ortsteil: 'Friedenau' });
  });

  it('neither PLZ nor Ortsteil → error', () => {
    expect(() => PlzQuery.parse({ street: 'Handjerystraße' })).toThrow('Нужен PLZ или район');
  });
});

describe('plzsOf / plzTitle', () => {
  it('counts addresses per PLZ, biggest first', () => {
    const at = (plz: string) => ({ ...addr('A', 1, 0), plz });
    expect(plzsOf([at('12161'), at('12159'), at('12161')])).toEqual([
      { plz: '12161', addresses: 2 },
      { plz: '12159', addresses: 1 },
    ]);
  });

  it.each([
    [{ plz: '10439' }, 'PLZ 10439'],
    [{ plz: '10439', street: 'Schivelbeiner Straße' }, 'Schivelbeiner Straße, 10439'],
    [{ ortsteil: 'Friedenau' }, 'Friedenau'],
    [{ ortsteil: 'Friedenau', plz: '12161' }, 'Friedenau, PLZ 12161'],
    [{ ortsteil: 'Friedenau', street: 'Handjerystraße' }, 'Handjerystraße, Friedenau'],
  ])('%o → %s', (q, title) => {
    expect(plzTitle(q)).toBe(title);
  });
});

describe('zone map', () => {
  it('compactGeometry rounds to ~10 m and drops repeated points', () => {
    const g = compactGeometry({ type: 'Polygon', coordinates: [[[13.400001, 52.5], [13.400002, 52.5], [13.41, 52.5], [13.41, 52.51], [13.400001, 52.5]]] });
    expect(g.coordinates).toEqual([[[13.4, 52.5], [13.41, 52.5], [13.41, 52.51], [13.4, 52.5]]]);
  });

  it('labels every zone with its number and marks every school; nothing without geometry', () => {
    const school = { bsn: '07G17', name: 'Stechlinsee-Grundschule', lon: 13.33, lat: 52.47 } as ZoneShare['schools'][number];
    const z = (esb: string, x0: number): ZoneShare => ({
      esb,
      esbText: null,
      status: 'exact',
      schools: [school],
      addresses: 1,
      plzs: [],
      streets: [],
      geometry: { type: 'Polygon', coordinates: [[[x0, 52.46], [x0 + 0.01, 52.46], [x0 + 0.01, 52.48], [x0, 52.46]]] },
      points: [[x0 + 0.005, 52.47]],
    });
    const svg = zoneMap([z('0717', 13.32), z('0716', 13.34)]);
    expect(svg.match(/class="label"[^>]*>(\d+)</g)?.map((t) => t.slice(-5, -1))).toEqual(['0717', '0716']);
    expect(svg.match(/class="school"/g)).toHaveLength(1); // одна школа двух зон — один маркер
    expect(zoneMap([{ ...z('0717', 13.32), geometry: undefined, points: undefined }])).toBe('');
  });
});

describe('share', () => {
  it.each([
    [1, 775, '<1 %'],
    [0, 775, '0 %'],
    [734, 1506, '49 %'],
    [429, 430, '>99 %'],
    [430, 430, '100 %'],
  ])('%i of %i → %s', (n, total, text) => {
    expect(share(n, total)).toBe(text);
  });
});
