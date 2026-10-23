import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPage, type PageData } from '../../src/extract.js';
import type { SchoolData } from '../../src/portrait.js';
import { scoreSchool, verdict } from '../../src/score.js';

const fixture = (name: string) => extractPage(readFileSync(new URL(`../fixtures/${name}.html`, import.meta.url), 'utf8'));
const table = (rows: string[][]): PageData => ({ status: 'ok', caption: '', rows, headRows: 0, dataStand: null });
const vunt = (school: string, schulart: string) =>
  table([['Ausfall von Unterricht', school], ['Ausfall von Unterricht in der Schulart', schulart]]);
const uvers = (bilanz: string) => table([['Bilanz in Stunden', bilanz]]);
const data = (pages: SchoolData['pages']) => ({ pages }) as SchoolData;

describe('scoreSchool', () => {
  it('01G01 fixtures: nothing worse than Schulart', () => {
    const s = scoreSchool(
      data({
        vunt: [{ year: '2025/26', data: fixture('01G01_management_vunt') }],
        uvers: [{ year: '2025/26', data: fixture('01G01_schulpersonal_uvers') }],
      }),
    );
    expect(s[0].years[0]).toEqual({ year: '2025/26', value: '1,2%', ref: '2,9%', worse: false });
    expect(s[1].years[0].worse).toBe(false);
    expect(verdict(s)).toEqual({ light: 'green', text: '🟢 Отмены не выше средней и учителей хватает — 1 год из 1' });
  });

  it('above Schulart → worse, equal → not; negative balance → worse, zero → not', () => {
    const [ausfall, bilanz] = scoreSchool(
      data({
        vunt: [{ year: '2025/26', data: vunt('3,0%', '2,9%') }, { year: '2024/25', data: vunt('2,9%', '2,9%') }],
        uvers: [{ year: '2025/26', data: uvers('-4,4') }, { year: '2024/25', data: uvers('0,0') }],
      }),
    );
    expect(ausfall.years.map((y) => y.worse)).toEqual([true, false]);
    expect(bilanz.years.map((y) => y.worse)).toEqual([true, false]);
    expect([ausfall.light, bilanz.light]).toEqual(['yellow', 'yellow']); // ✗ ровно в половине — ещё не 🔴
  });

  it('metric light: no ✗ → green, ✗ in more than half → red, no data → nd', () => {
    const s = scoreSchool(
      data({
        vunt: [{ year: '2025/26', data: vunt('1,0%', '2,9%') }],
        uvers: [{ year: '2025/26', data: uvers('-1,0') }, { year: '2024/25', data: uvers('-2,0') }, { year: '2023/24', data: uvers('3,0') }],
      }),
    );
    expect(s.map((m) => m.light)).toEqual(['green', 'red']);
    expect(scoreSchool(data({})).map((m) => m.light)).toEqual(['nd', 'nd']);
  });

  it('thousands separator: "1.023,4" is a thousand, not 1', () => {
    const [ausfall] = scoreSchool(data({ vunt: [{ year: '2025/26', data: vunt('1.023,4', '999,0') }] }));
    expect(ausfall.years[0].worse).toBe(true);
  });

  it('missing comparison row or no_data page → null, never a guess', () => {
    const [ausfall] = scoreSchool(
      data({
        vunt: [
          { year: '2025/26', data: table([['Ausfall von Unterricht', '1,0%']]) },
          { year: '2024/25', data: fixture('01G24_fehl_nodata') },
        ],
      }),
    );
    expect(ausfall.years.map((y) => y.worse)).toEqual([null, null]);
    expect(verdict(scoreSchool(data({}))).light).toBe('nd');
  });
});

describe('verdict', () => {
  const years3 = (f: (i: number) => PageData) => ['2025/26', '2024/25', '2023/24'].map((year, i) => ({ year, data: f(i) }));

  it('names only the metrics with ✗, in years out of years with data', () => {
    const v = verdict(
      scoreSchool(
        data({
          vunt: years3((i) => [vunt('4,0%', '2,9%'), vunt('2,0%', '2,8%'), vunt('1,1%', '3,0%')][i]),
          uvers: years3((i) => uvers(['-4,4', '-52,1', '38,6'][i])),
        }),
      ),
    );
    expect(v).toEqual({ light: 'red', text: '🔴 Отмены выше средней — 1 год из 3 · Не хватает учителей — 2 года из 3' });
  });

  it('light is the worst metric light; a metric without ✗ is not mentioned', () => {
    const v = verdict(scoreSchool(data({ vunt: years3(() => vunt('1,0%', '2,9%')), uvers: years3(() => uvers('-1,0')) })));
    expect(v).toEqual({ light: 'red', text: '🔴 Не хватает учителей — 3 года из 3' });
    const yellow = verdict(scoreSchool(data({ vunt: years3((i) => vunt(i ? '1,0%' : '4,0%', '2,9%')), uvers: years3(() => uvers('1,0')) })));
    expect(yellow).toEqual({ light: 'yellow', text: '🟡 Отмены выше средней — 1 год из 3' });
    const red = verdict(scoreSchool(data({ vunt: years3(() => vunt('4,0%', '2,9%')), uvers: years3((i) => uvers(i ? '-1,0' : '1,0')) })));
    expect(red).toEqual({ light: 'red', text: '🔴 Отмены выше средней — 3 года из 3 · Не хватает учителей — 2 года из 3' });
  });

  it('green: one phrase when years match, per metric when they differ', () => {
    expect(verdict(scoreSchool(data({ vunt: years3(() => vunt('1,0%', '2,9%')), uvers: years3(() => uvers('1,0')) }))).text).toBe(
      '🟢 Отмены не выше средней и учителей хватает — все 3 года',
    );
    expect(
      verdict(scoreSchool(data({ vunt: years3(() => vunt('1,0%', '2,9%')), uvers: [{ year: '2025/26', data: uvers('1,0') }] }))).text,
    ).toBe('🟢 Отмены не выше средней — 3 года из 3 · учителей хватает — 1 год из 1');
  });
});
