import { describe, expect, it } from 'vitest';
import { assignSchool, type School } from '../../src/geo.js';

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

  it('several inside, zone code matches bsn → matched_by_code', () => {
    expect(assignSchool('0110', [a, b], all, home, {})).toMatchObject({
      status: 'matched_by_code',
      schools: [{ bsn: '01G10' }],
    });
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
});
