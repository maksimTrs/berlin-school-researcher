import type { APIRequestContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { config, currentEsbLayer } from '../../src/config.js';
import { checkWithoutZone, geocode, groupByZone, noZoneSchools, onStreet, plzZones, resolveStatus, schoolsCql, type Feature } from '../../src/geo.js';

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
const address = (street: string, hnr: number, lon: number, ort_name = 'Rudow', plz = '12357') =>
  point(`${street} ${hnr}`, lon, { str_name: street, hnr, plz, ort_name, bez_name: 'Neukölln' });
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

describe('currentEsbLayer', () => {
  it('zones of the current school year; the new one starts on 1 August, Berlin time', () => {
    expect(currentEsbLayer(new Date('2026-07-31T21:59:00Z'))).toBe('esb_2025'); // 31.07 23:59 в Берлине
    expect(currentEsbLayer(new Date('2026-07-31T22:00:00Z'))).toBe('esb_2026'); // 01.08 00:00 в Берлине
    expect(currentEsbLayer(new Date('2026-10-24T12:00:00Z'))).toBe('esb_2026');
    expect(currentEsbLayer(new Date('2027-03-15T12:00:00Z'))).toBe('esb_2026'); // переезд посреди 2026/27
  });
});

describe('schoolsCql', () => {
  it('Grundschule/Gemeinschaftsschule plus every school named in esbOverrides, whatever its type', () => {
    const types = "traeger='oeffentlich' AND schulart IN ('Grundschule','Gemeinschaftsschule')";
    expect(schoolsCql({})).toEqual([types]);
    // отдельным запросом: «… OR bsn IN (…)» отклоняет WAF gdi.berlin.de
    expect(schoolsCql({ '0799': ['07G40', '07G06'], '0457': '04S07', '0798': '07G06' })).toEqual([
      types,
      "traeger='oeffentlich' AND bsn IN ('07G40','07G06','04S07')",
    ]);
  });
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
    expect(await plzZones(api, { plz: '12357', street: 'Am Wald' })).toEqual({ total: 0, zones: [], excludedByOrtsteil: null });
  });

  it('--street keeps only the exact street', async () => {
    const api = fakeApi(layers([address('Am Wald', 1, 13.4), address('Am Waldidyll', 2, 13.4)]));
    const r = await plzZones(api, { plz: '12357', street: 'Am Wald' });
    expect(r.total).toBe(1);
    expect(r.zones[0].streets).toEqual([{ street: 'Am Wald', houses: ['1'] }]);
  });

  it('two schools in a Mitte zone: no code match (Mitte numbers zones on its own) → ambiguous, nearest first', async () => {
    const r = await plzZones(fakeApi(layers([address('Am Wald', 1, 13.4)])), { plz: '12357' });
    expect(r.zones.map((z) => [z.status, z.schools.map((s) => s.bsn)])).toEqual([['ambiguous', ['01G01', '01G10']]]);
  });
});

describe('plzZones: Ortsteil', () => {
  it('keeps only the exact Ortsteil (spelling folded) and counts addresses per PLZ', async () => {
    // ILIKE «sch%neberg» отдал бы и соседний район с похожим именем — его отсеивает точное сравнение
    const api = fakeApi(
      layers([
        address('Hauptstraße', 1, 13.4, 'Schöneberg', '10827'),
        address('Hauptstraße', 2, 13.4, 'Schöneberg', '10827'),
        address('Akazienstraße', 1, 13.4, 'Schöneberg', '10823'),
        address('Rheinstraße', 1, 13.4, 'Friedenau', '12159'),
      ]),
    );
    const r = await plzZones(api, { ortsteil: 'Schoeneberg' });
    expect(r.total).toBe(3);
    expect(r.zones[0].plzs).toEqual([
      { plz: '10827', addresses: 2 },
      { plz: '10823', addresses: 1 },
    ]);
    expect(r.excludedByOrtsteil).toBeNull(); // без PLZ — не с чем сравнивать
  });

  it('PLZ + Ortsteil: houses of the PLZ in other Ortsteile are counted, not dropped silently', async () => {
    const api = fakeApi(
      layers([
        address('Rüdesheimer Platz', 1, 13.4, 'Wilmersdorf', '14197'),
        address('Rüdesheimer Platz', 2, 13.4, 'Wilmersdorf', '14197'),
        address('Binger Straße', 30, 13.4, 'Schmargendorf', '14197'),
      ]),
    );
    const r = await plzZones(api, { plz: '14197', ortsteil: 'Wilmersdorf' });
    expect([r.total, r.excludedByOrtsteil]).toEqual([2, { addresses: 1, ortsteile: ['Schmargendorf'], zones: [{ esb: '0110', school: null, addresses: 1 }] }]); // в зоне две школы — однозначной нет
    // район назван неверно для PLZ — домов нет, но видно, в каких районах они есть
    const wrong = await plzZones(api, { plz: '14197', ortsteil: 'Friedenau' });
    expect([wrong.total, wrong.excludedByOrtsteil?.ortsteile]).toEqual([0, ['Schmargendorf', 'Wilmersdorf']]);
  });
});

describe('schoolsWithoutZone: checked against the layer on every run and by canary', () => {
  // в слое есть только зона 0110: у 01G10 своя зона появилась, у 01G01 её нет (0101), 01G99 нет в реестре
  it('a listed school that got its own zone is a regular candidate again', async () => {
    expect([...(await noZoneSchools(fakeApi(layers([])), ['01G10', '01G01']))]).toEqual(['01G01']);
  });

  it('canary: listed school gone from the registry or with its own zone → stale entry', async () => {
    expect(await checkWithoutZone(fakeApi(layers([])), ['01G10', '01G01', '01G99'])).toEqual([
      `schoolsWithoutZone: у 01G10 в слое ${config.esbLayer} есть своя зона 0110 — школа снова кандидат, запись сверить и убрать`,
      'schoolsWithoutZone: школы 01G99 нет в реестре schulen — запись убрать',
    ]);
  });
});

describe('onStreet / WFS / zone holes', () => {
  it('onStreet: lookup keeps only candidates on the requested street', async () => {
    const q = { street: 'Am Wald', house: 3, plz: '12357' };
    expect(onStreet(q, await geocode(fakeApi(layers([address('Am Waldidyll', 3, 13.4)])), q))).toEqual([]);
    expect(onStreet(q, await geocode(fakeApi(layers([address('Am Wald', 3, 13.4)])), q)).map((c) => c.street)).toEqual(['Am Wald']);
  });

  it('a truncated WFS response is an error, not fewer addresses', async () => {
    const api = {
      get: async () => ({ ok: () => true, json: async () => ({ numberMatched: 3, features: [address('Am Wald', 1, 13.4)] }) }),
    } as unknown as APIRequestContext;
    await expect(plzZones(api, { plz: '12357' })).rejects.toThrow('отдано 1 из 3 объектов');
  });

  it('an address in a hole of zone A belongs to the enclave zone B', () => {
    const square = (a: number, b: number) => [[a, a], [b, a], [b, b], [a, b], [a, a]];
    const outer: Feature = { id: 'A', properties: { esb: 'A' }, geometry: { type: 'Polygon', coordinates: [square(0, 10), square(4, 6)] } };
    const enclave: Feature = { id: 'B', properties: { esb: 'B' }, geometry: { type: 'Polygon', coordinates: [square(4, 6)] } };
    const at = (lon: number) => ({ street: 'X', house: 1, suffix: null, lon, lat: lon });
    const groups = groupByZone([at(5), at(1)], [outer, enclave]);
    expect(Object.fromEntries(groups.map((g) => [g.zone.id, g.addrs.map((a) => a.lon)]))).toEqual({ A: [1], B: [5] });
  });
});
