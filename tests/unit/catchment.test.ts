import { describe, expect, it } from 'vitest';
import { assignSchool, overrideIgnored, type School } from '../../src/geo.js';

const school = (bsn: string, lon: number): School => ({
  bsn,
  name: bsn,
  schulart: 'Grundschule',
  address: '',
  ortsteil: '',
  bezirk: '',
  phone: null,
  email: null,
  web: null,
  lon,
  lat: 52.5,
});
const home = { lon: 13.4, lat: 52.5 };
const a = school('01G01', 13.401);
const b = school('01G10', 13.402);
const c = school('01G20', 13.403);
const all = [a, b, c];

describe('assignSchool', () => {
  it('one school inside → exact', () => {
    expect(assignSchool('0110', [a], all, home, {})).toMatchObject({ status: 'exact', schools: [{ bsn: '01G01' }] });
  });

  it('one Grundschule inside with another zone’s code (outside Mitte) → code_mismatch, the school with the zone’s code second', () => {
    // esb_2026, Lichtenberg: в зоне 1102 стоит только 11G03, а 11G02 — в зоне 1132
    const g03 = school('11G03', 13.401);
    const g02 = school('11G02', 13.41);
    const r = assignSchool('1102', [g03], [g03, g02, school('11G32', 13.42)], home, {});
    expect([r.status, r.schools.map((s) => s.bsn)]).toEqual(['code_mismatch', ['11G03', '11G02']]);
    // школы с кодом зоны нет — кандидат один, но предупреждение остаётся
    expect(assignSchool('1102', [g03], [g03], home, {})).toMatchObject({ status: 'code_mismatch', schools: [{ bsn: '11G03' }] });
  });

  it('code is not compared in Mitte (own zone numbering) and for Gemeinschaftsschulen (own scheme) → exact', () => {
    const k = school('02K04', 13.401);
    expect(assignSchool('0294', [k], [k], home, {}).status).toBe('exact');
    expect(assignSchool('0110', [a], all, home, {}).status).toBe('exact');
  });

  it('several inside, zone code matches bsn → matched_by_code, the rest of the zone kept after it by distance', () => {
    const [x, y, z] = [school('04G01', 13.401), school('04G10', 13.402), school('04G20', 13.403)];
    const r = assignSchool('0410', [z, x, y], [x, y, z], home, {});
    expect(r.status).toBe('matched_by_code');
    expect(r.schools.map((s) => s.bsn)).toEqual(['04G10', '04G01', '04G20']);
  });

  it('several inside: a code “match” in Mitte or with a Gemeinschaftsschule means nothing → ambiguous', () => {
    expect(assignSchool('0110', [c, a, b], all, home, {}).status).toBe('ambiguous');
    // esb_2026, Pankow: 03K07 даёт «0307» случайно — у Gemeinschaftsschule своя нумерация зон
    const [k, g] = [school('03K07', 13.401), school('03G48', 13.402)];
    expect(assignSchool('0307', [g, k], [k, g], home, {})).toMatchObject({ status: 'ambiguous', schools: [{ bsn: '03K07' }, { bsn: '03G48' }] });
  });

  it('several inside, no code match → ambiguous, nearest first', () => {
    const r = assignSchool('0199', [c, a], all, home, {});
    expect(r.status).toBe('ambiguous');
    expect(r.schools.map((s) => s.bsn)).toEqual(['01G01', '01G20']);
  });

  it('none inside → 3 nearest to the address', () => {
    const r = assignSchool('0108', [], all, home, {});
    expect(r.status).toBe('no_school_in_zone');
    expect(r.schools.map((s) => s.bsn)).toEqual(['01G01', '01G10', '01G20']);
  });

  it('override wins over spatial rules', () => {
    expect(assignSchool('0110', [a], all, home, { '0110': '01G20' })).toMatchObject({
      status: 'override',
      schools: [{ bsn: '01G20' }],
    });
  });

  it('override list = joint zone: all listed schools, nearest first', () => {
    const r = assignSchool('0110', [a], all, { lon: 13.4035, lat: 52.5 }, { '0110': ['01G01', '01G20'] });
    expect([r.status, r.schools.map((s) => s.bsn)]).toEqual(['joint', ['01G20', '01G01']]);
  });

  it('school without its own zone (SESB) standing in this one is not a candidate, but is reported', () => {
    // зона 0423: Alt-Schmargendorf (04G23) и Judith-Kerr (04G27, SESB) на одном кампусе, зоны 0427 нет
    const own = school('04G23', 13.401);
    const sesb = school('04G27', 13.4005);
    const r = assignSchool('0423', [sesb, own], [own, sesb], home, {}, new Set(['04G27']));
    expect([r.status, r.schools.map((s) => s.bsn), r.withoutZone?.map((s) => s.bsn)]).toEqual(['exact', ['04G23'], ['04G27']]);
    // своя зона у школы есть (её нет в noZone) — обычный кандидат
    const mixed = assignSchool('0420', [school('04G20', 13.401), school('04G21', 13.402)], all, home, {}, new Set());
    expect([mixed.status, mixed.schools.map((s) => s.bsn), mixed.withoutZone]).toEqual(['matched_by_code', ['04G20', '04G21'], []]);
    // одна в чужой зоне — зона без школы, и в «3 ближайших» её тоже нет
    const alone = assignSchool('0499', [sesb], [sesb, ...all], home, {}, new Set(['04G27']));
    expect([alone.status, alone.schools.map((s) => s.bsn), alone.withoutZone?.map((s) => s.bsn)]).toEqual(['no_school_in_zone', ['01G01', '01G10', '01G20'], ['04G27']]);
  });

  it('override with a school gone from the registry is ignored', () => {
    expect(assignSchool('0110', [a], all, home, { '0110': ['01G01', '01G99'] }).status).toBe('exact');
  });

  it('overrideIgnored: an override that fell back to the map is a warning; applied or absent — none', () => {
    const o = { '0110': ['01G01', '01G99'] };
    expect(overrideIgnored({ esb: '0110', status: 'exact' }, o)).toContain('Поправка esbOverrides для зоны 0110 (01G01, 01G99) не применена');
    expect(overrideIgnored({ esb: '0110', status: 'joint' }, o)).toBeNull();
    expect(overrideIgnored({ esb: '0111', status: 'exact' }, o)).toBeNull();
  });
});
