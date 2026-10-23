// Живые сервисы gdi.berlin.de, эталонные адреса S1–S5 (значения сняты 23.10.2026). Портрет школы проверяет `npm run canary`.
import type { APIRequestContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApi } from '../src/config.js';
import { catchment, geocode, neighbors } from '../src/geo.js';
import { parseAddress } from '../src/schema.js';

let api: APIRequestContext;
beforeAll(async () => {
  api = await newApi();
});
afterAll(() => api.dispose());

const resolveOne = async (raw: string) => {
  const cands = await geocode(api, parseAddress(raw));
  expect(cands).toHaveLength(1);
  return { addr: cands[0], c: await catchment(api, cands[0]) };
};

describe('smoke: address → catchment → school', { timeout: 30_000 }, () => {
  it('S1 Ruppiner Straße 47 → 0110 → 01G01 exact, neighbours 01G39/01G38', async () => {
    const { addr, c } = await resolveOne('Ruppiner Straße 47, 10115');
    expect(c).toMatchObject({ esb: '0110', status: 'exact', schools: [{ bsn: '01G01' }] });
    expect((await neighbors(api, addr, c.schools, 2)).map((s) => s.bsn)).toEqual(['01G39', '01G38']);
  });

  it('S2 Kastanienallee 12 without PLZ → 7 candidates', async () => {
    expect(await geocode(api, parseAddress('Kastanienallee 12'))).toHaveLength(7);
  });

  it('S2b Kastanienallee 12 + listing district hint, no PLZ → 1 candidate', async () => {
    const cands = await geocode(api, parseAddress('Kastanienallee 12, Prenzlauer Berg (Prenzlauer Berg)'));
    expect(cands).toHaveLength(1);
    expect(cands[0]).toMatchObject({ plz: '10435', ortsteil: 'Prenzlauer Berg' });
  });

  it('S2c ß/ss spelling: Grossbeerenstrasse 5 finds Großbeerenstraße', async () => {
    const [c] = await geocode(api, parseAddress('Grossbeerenstrasse 5, 12107'));
    expect(c?.street).toBe('Großbeerenstraße');
  });

  it('S3 Kastanienallee 12, 10435 → Prenzlauer Berg (Pankow)', async () => {
    const [c, ...rest] = await geocode(api, parseAddress('Kastanienallee 12, 10435'));
    expect(rest).toHaveLength(0);
    expect(c).toMatchObject({ ortsteil: 'Prenzlauer Berg', bezirk: 'Pankow' });
  });

  it('S4 Feldzeugmeisterstraße 10 → 0109 ambiguous: 01G11 + 01K10', async () => {
    const { c } = await resolveOne('Feldzeugmeisterstraße 10, 10557');
    expect(c.esb).toBe('0109');
    expect(c.status).toBe('ambiguous');
    expect(c.schools.map((s) => s.bsn).sort()).toEqual(['01G11', '01K10']);
  });

  it('S5 Beusselstraße 44F → 0108 without school → 3 nearest', async () => {
    const { c } = await resolveOne('Beusselstraße 44F, 10553');
    expect(c.esb).toBe('0108');
    expect(c.status).toBe('no_school_in_zone');
    expect(c.schools).toHaveLength(3);
  });
});
