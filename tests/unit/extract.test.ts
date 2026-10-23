import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  availableYears,
  captionYear,
  extractInspections,
  extractPage,
  extractProfile,
  forYear,
  keyFigure,
} from '../../src/extract.js';
import { yearRequests } from '../../src/portrait.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}.html`, import.meta.url), 'utf8');

describe('extractPage', () => {
  it('vunt: values, comparison rows, year and data date', () => {
    const p = extractPage(fixture('01G01_management_vunt'));
    expect(p.status).toBe('ok');
    expect(captionYear(p)).toBe('2025/26');
    expect(p.dataStand).toBe('2025/26');
    expect(keyFigure(p, 'Ausfall von Unterricht', 1)).toBe('1,2%');
    expect(keyFigure(p, 'Ausfall von Unterricht in Berlin', 1)).toBe('3,0%');
  });

  it('forYear: table of another year than requested → no_data, not its figures', () => {
    const p = extractPage(fixture('01G01_management_vunt'));
    expect(forYear(p, '2025/26')).toBe(p);
    const other = forYear(p, '2023/24');
    expect(other.status).toBe('no_data');
    expect(keyFigure(other, 'Ausfall von Unterricht', 1)).toBeNull();
  });

  it('uvers: teacher balance', () => {
    const p = extractPage(fixture('01G01_schulpersonal_uvers'));
    expect(keyFigure(p, 'Bilanz in Stunden', 1)).toBe('53,1');
    expect(p.dataStand).toBe('01.11.2025');
  });

  it('pers: decodes HTML entities in row labels', () => {
    const p = extractPage(fixture('01G01_schulpersonal_pers'));
    expect(p.rows.map((r) => r[0])).toContain('Lehramtsanwärter/in');
    expect(keyFigure(p, 'Lehrkräfte', -1)).toBe('38');
  });

  it('ndh: last row holds totals and share', () => {
    const p = extractPage(fixture('01G01_schuelerschaft_ndh'));
    expect(keyFigure(p, null, 0)).toBe('425');
    expect(keyFigure(p, null, -1)).toBe('45,4');
  });

  it('header rows: colspan padded, <th> rows counted; empty header row dropped', () => {
    const ndh = extractPage(fixture('01G01_schuelerschaft_ndh'));
    expect(ndh.headRows).toBe(2);
    expect(ndh.rows[0]).toHaveLength(5); // 1 + colspan 4
    expect(extractPage(fixture('01G01_management_vunt')).headRows).toBe(0);
  });

  it('"keine Daten verfügbar" → no_data, no rows, key figure null', () => {
    const p = extractPage(fixture('01G24_fehl_nodata'));
    expect(p.status).toBe('no_data');
    expect(p.rows).toEqual([]);
    expect(keyFigure(p, 'der Schule', 1)).toBeNull();
  });

  it('empty Daten-Stand → null', () => {
    expect(extractPage(fixture('01G01_schuelerschaft_fehl')).dataStand).toBeNull();
  });
});

describe('portrait helpers', () => {
  it('availableYears: only links of the given subpage, newest first', () => {
    const years = availableYears(fixture('01G01_management_vunt'), 'management.aspx?view=vunt', 'Vertretungsunterricht 2025/26');
    expect([...years].slice(0, 3)).toEqual([
      ['2025/26', '2025/26'],
      ['2024/25', '2024/25'],
      ['2023/24', '2023/24'],
    ]);
  });

  it('availableYears: year with a suffix → the exact jahr value of the link', () => {
    const uvers = availableYears(fixture('01G01_schulpersonal_uvers'), 'schulpersonal.aspx?view=uvers', 'Unterrichtsversorgung 2025/26 (01.11.2025)');
    expect(uvers.get('2024/25')).toBe('2024/25 (01.11.2024)');
    const html = fixture('01G01_schuelerschaft_fehl');
    const fehl = availableYears(html, 'schuelerschaft.aspx?view=fehl', extractPage(html).caption);
    expect([...fehl.keys()].slice(0, 3)).toEqual(['2025/26', '2024/25', '2023/24']);
    expect(fehl.get('2024/25')).toBe('2024/25 (1.Shj K5-6)');
    expect(fehl.get('2004/05')).toBe('2004/05'); // пробелы-заполнители в конце href отброшены
  });

  it('availableYears: several variants of a year → the half of the current caption, else the first link', () => {
    const fehl = availableYears(fixture('01G01_schuelerschaft_fehl'), 'schuelerschaft.aspx?view=fehl', 'Fehlzeiten 2025/26 (2.Shj K5-6)');
    expect(fehl.get('2018/19')).toBe('2018/19 (2.Shj K5-6)');
    expect(fehl.get('2019/20')).toBe('2019/20 (1.Shj K5-6)'); // 2.Shj за этот год нет
    const bare = availableYears(fixture('01G24_fehl_nodata'), 'schuelerschaft.aspx?view=fehl', 'Fehlzeiten 2008/09');
    expect(bare.get('2018/19')).toBe('2018/19 (1.Shj K5-6)');
  });

  it('yearRequests: every trend year, current page reused, others by the exact jahr', () => {
    const html = fixture('01G01_schuelerschaft_fehl');
    const links = availableYears(html, 'schuelerschaft.aspx?view=fehl', extractPage(html).caption);
    expect(yearRequests(['2025/26', '2024/25', '2023/24'], '2025/26', links)).toEqual([
      { year: '2025/26', jahr: null },
      { year: '2024/25', jahr: '2024/25 (1.Shj K5-6)' },
      { year: '2023/24', jahr: '2023/24 (1.Shj K5-6)' },
    ]);
  });

  it('yearRequests: page still on last year at the rollover → same years as vunt, not its own', () => {
    const links = new Map([['2024/25', '2024/25 (01.11.2024)'], ['2023/24', '2023/24 (01.11.2023)']]);
    expect(yearRequests(['2025/26', '2024/25'], '2024/25', links)).toEqual([
      { year: '2025/26', jahr: '2025/26' }, // ссылки нет — сам год; чужой год в ответе forYear сделает «нет данных»
      { year: '2024/25', jahr: null },
    ]);
  });

  it('extractProfile: name and non-empty fields', () => {
    const p = extractProfile(fixture('01G01_portrait'));
    expect(p.name).toBe('Grundschule am Arkonaplatz - 01G01');
    expect(Object.fromEntries(p.fields)['Директор']).toBe('Scheible, Ina');
  });

  it('extractInspections: absolute PDF links', () => {
    const links = extractInspections(
      fixture('01G01_schulinspektion'),
      'https://www.bildung.berlin.de/Schulverzeichnis/schulinspektion.aspx',
    );
    expect(links).toHaveLength(2);
    expect(links[1].url).toBe(
      'https://www.bildung.berlin.de/Schulverzeichnis/DokLoader.aspx?Schulinspektion=01G01_B_20250501.pdf',
    );
  });

  it('extractInspections: drops non-https and foreign hosts', () => {
    const html = `<a href="javascript:alert(1)//DokLoader.aspx?Schulinspektion=x">a</a>
      <a href="https://evil.example/DokLoader.aspx?Schulinspektion=x">b</a>`;
    expect(extractInspections(html, 'https://www.bildung.berlin.de/Schulverzeichnis/')).toEqual([]);
  });
});
