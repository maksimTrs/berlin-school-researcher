import type { APIRequestContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { geocode, plzZones, resolveStatus, type Feature } from '../../src/geo.js';

// WFS отвечает по слою из typeNames; CQL-фильтр не применяется — ответ задан таким, каким его вернул бы ILIKE по префиксу
const fakeApi = (layers: Record<string, Feature[]>) =>
  ({
    get: async (url: string) => {
      const features = layers[new URL(url).searchParams.get('typeNames')!] ?? [];
      return { ok: () => true, json: async () => ({ features }) };
    },
  }) as unknown as APIRequestContext;

const point = (id: string, lon: number, properties: Record<string, any>): Feature => ({
  id,
  geometry: { type: 'Point', coordinates: [lon, 52.5] },
  properties,
});
const address = (street: string, hnr: number, lon: number) =>
  point(`${street} ${hnr}`, lon, { str_name: street, hnr, plz: '12357', ort_name: 'Rudow', bez_name: 'Neukölln' });
const school = (bsn: string, lon: number) =>
  point(bsn, lon, { bsn, schulname: bsn, schulart: 'Grundschule', strasse: 'X', hausnr: '1', plz: '12357' });
// зона 0110 — квадрат вокруг всех точек
const zone: Feature = {
  id: '0110',
  properties: { esb: '0110' },
  geometry: { type: 'Polygon', coordinates: [[[13.3, 52.4], [13.5, 52.4], [13.5, 52.6], [13.3, 52.6], [13.3, 52.4]]] },
};
const layers = (addresses: Feature[]) => ({
  'adressen_berlin:adressen_berlin': addresses,
  [`esb:${config.esbLayer}`]: [zone],
  'schulen:schulen': [school('01G01', 13.401), school('01G10', 13.402)],
});

describe('geocode + resolveStatus: prefix sibling street', () => {
  it('only «Am Waldidyll 3» exists for «Am Wald 3» → ambiguous, not exact', async () => {
    const q = { street: 'Am Wald', house: 3, plz: '12357' };
    const cands = await geocode(fakeApi(layers([address('Am Waldidyll', 3, 13.4)])), q);
    expect(cands.map((c) => c.street)).toEqual(['Am Waldidyll']);
    expect(resolveStatus(q, cands)).toBe('ambiguous');
  });

  it('same street in another spelling → exact', async () => {
    const q = { street: 'Am Waldidyll', house: 3, plz: '12357' };
    expect(resolveStatus(q, await geocode(fakeApi(layers([address('Am Waldidyll', 3, 13.4)])), q))).toBe('exact');
  });
});

describe('plzZones', () => {
  it('--street with only a prefix sibling in the PLZ → nothing found', async () => {
    const api = fakeApi(layers([address('Am Waldidyll', 1, 13.4), address('Am Waldidyll', 2, 13.4)]));
    expect(await plzZones(api, { plz: '12357', street: 'Am Wald' })).toEqual({ total: 0, zones: [] });
  });

  it('--street keeps only the exact street', async () => {
    const api = fakeApi(layers([address('Am Wald', 1, 13.4), address('Am Waldidyll', 2, 13.4)]));
    const r = await plzZones(api, { plz: '12357', street: 'Am Wald' });
    expect(r.total).toBe(1);
    expect(r.zones[0].streets).toEqual([{ street: 'Am Wald', houses: ['1'] }]);
  });

  it('matched_by_code zone lists only the matched school', async () => {
    const r = await plzZones(fakeApi(layers([address('Am Wald', 1, 13.4)])), { plz: '12357' });
    expect(r.zones.map((z) => [z.status, z.schools.map((s) => s.bsn)])).toEqual([['matched_by_code', ['01G10']]]);
  });
});
