import { keyFigure, type PageKey } from './extract.js';
import type { SchoolData } from './portrait.js';

/**
 * Маркер без своих порогов: каждый показатель за каждый год — хуже или не хуже средней по типу школ,
 * которую публикует сам сайт (`ref`); без `ref` — хуже, если значение < 0 (дефицит учительских часов).
 * Пропуски сюда не входят: у начальных школ — только 5–6 классы, обычно один год из трёх, разница в десятые доли.
 */
export const SCORES = [
  { key: 'ausfall', page: 'vunt', title: 'Отмены уроков', row: 'Ausfall von Unterricht', ref: 'Ausfall von Unterricht in der Schulart', col: 1, unit: '', worse: 'Отмены выше средней', ok: 'отмены не выше средней' },
  { key: 'bilanz', page: 'uvers', title: 'Учителя (баланс часов)', row: 'Bilanz in Stunden', ref: null, col: 1, unit: ' ч', worse: 'Не хватает учителей', ok: 'учителей хватает' },
] as const satisfies readonly { key: string; page: PageKey; title: string; row: string; ref: string | null; col: number; unit: string; worse: string; ok: string }[];

/** worse = null — нет данных за год (или нет строки средней для сравнения). */
export type YearScore = { year: string; value: string | null; ref: string | null; worse: boolean | null };
export type Light = 'green' | 'yellow' | 'red' | 'nd';
export type MetricScore = (typeof SCORES)[number] & { light: Light; years: YearScore[] };
export type Verdict = { light: Light; text: string };

export const EMOJI: Record<Light, string> = { green: '🟢', yellow: '🟡', red: '🔴', nd: '⚪' };

/** Одно правило и для строки показателя, и для итога: 🟢 ни одного «хуже», 🔴 «хуже» больше чем в половине, иначе 🟡. */
function lightOf(years: YearScore[]): Light {
  const known = years.filter((y) => y.worse !== null);
  const bad = known.filter((y) => y.worse).length;
  return !known.length ? 'nd' : !bad ? 'green' : bad * 2 > known.length ? 'red' : 'yellow';
}

// на сайте «1.875,9» — точка разделяет тысячи, запятая — дробную часть
const num = (s: string | null) => (s === null ? NaN : Number.parseFloat(s.replace('%', '').replace(/\./g, '').replace(',', '.')));

/** Годы — как у подстраницы, от нового к старому. */
export function scoreSchool(data: SchoolData): MetricScore[] {
  return SCORES.map((s) => {
    const years = (data.pages[s.page] ?? []).map((yp): YearScore => {
      const value = keyFigure(yp.data, s.row, s.col);
      const ref = s.ref === null ? null : keyFigure(yp.data, s.ref, s.col);
      const v = num(value);
      const r = s.ref === null ? 0 : num(ref);
      return { year: yp.year, value, ref, worse: Number.isNaN(v) || Number.isNaN(r) ? null : s.ref === null ? v < r : v > r };
    });
    return { ...s, light: lightOf(years), years };
  });
}

const yearsWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'год' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'года' : 'лет');

/**
 * Итог по всем показателям и годам — словами, чтобы шапка сама объясняла цвет:
 * «🟡 Отмены выше средней — 1 год из 3 · Не хватает учителей — 2 года из 3».
 */
export function verdict(metrics: MetricScore[]): Verdict {
  const light = lightOf(metrics.flatMap((m) => m.years));
  const counts = metrics
    .map((m) => ({ m, known: m.years.filter((y) => y.worse !== null).length, bad: m.years.filter((y) => y.worse).length }))
    .filter((c) => c.known);
  if (light === 'nd') return { light, text: '⚪ Нет данных для оценки' };
  if (light === 'green') {
    const n = counts[0].known;
    // у показателей бывает разное число лет с данными — тогда пишем по каждому
    const text = counts.every((c) => c.known === n)
      ? `${counts.map((c) => c.m.ok).join(' и ')} — ${n === 1 ? '1 год из 1' : `все ${n} ${yearsWord(n)}`}`
      : counts.map((c) => `${c.m.ok} — ${c.known} ${yearsWord(c.known)} из ${c.known}`).join(' · ');
    return { light, text: `🟢 ${text[0].toUpperCase()}${text.slice(1)}` };
  }
  const parts = counts.filter((c) => c.bad).map((c) => `${c.m.worse} — ${c.bad} ${yearsWord(c.bad)} из ${c.known}`);
  return { light, text: `${EMOJI[light]} ${parts.join(' · ')}` };
}
