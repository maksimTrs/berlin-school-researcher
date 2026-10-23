import { describe, expect, it } from 'vitest';
import { groupByZone, streetsOf, type Feature, type PlzAddress } from '../../src/geo.js';
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
