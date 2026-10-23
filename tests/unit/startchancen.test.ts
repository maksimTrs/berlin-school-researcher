import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffSchools, kmlUrl, parseKml, startchancen } from '../../src/startchancen.js';

describe('startchancen', () => {
  it('parseKml: real KML excerpt, school listed in two layers → once, sorted', () => {
    const kml = readFileSync(new URL('../fixtures/startchancen_sample.kml', import.meta.url), 'utf8');
    expect(parseKml(kml)).toEqual(['01G43', '10G36']);
  });

  it('kmlUrl: map id from the embedded My Maps iframe', () => {
    const html = '<iframe src="https://www.google.com/maps/d/embed?mid=19XONJWHl6ywqLPHDuqJ9XGgugc5gDbg&#38;ehbc=2E312F">';
    expect(kmlUrl(html)).toBe('https://www.google.com/maps/d/kml?mid=19XONJWHl6ywqLPHDuqJ9XGgugc5gDbg&forcekml=1');
    expect(kmlUrl('<p>no map</p>')).toBeNull();
  });

  it('diffSchools: added and removed', () => {
    expect(diffSchools(['01G01', '01G18'], ['01G18', '04G21'])).toEqual({ added: ['04G21'], removed: ['01G01'] });
  });

  it('snapshot in config: sorted, unique', () => {
    const { schools } = startchancen();
    expect(schools).toEqual([...new Set(schools)].sort());
  });
});
