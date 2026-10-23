import { parse, type HTMLElement } from 'node-html-parser';

/** Подстраницы Schulporträt. Новая метрика = новая запись. `trend` — тянуть прошлые годы. */
export const PAGES = [
  { key: 'vunt', path: 'management.aspx?view=vunt', title: 'Отмены и замещения уроков', trend: true },
  { key: 'uvers', path: 'schulpersonal.aspx?view=uvers', title: 'Обеспеченность учителями', trend: true },
  { key: 'pers', path: 'schulpersonal.aspx?view=pers', title: 'Состав персонала', trend: true },
  { key: 'fehl', path: 'schuelerschaft.aspx?view=fehl', title: 'Пропуски', trend: true, note: 'Только 5–6 классы, 1-е полугодие; у начальных школ часто не публикуется.' },
  { key: 'nat', path: 'schuelerschaft.aspx?view=nat', title: 'Иностранное гражданство', trend: true, note: 'Только по континентам.' },
  { key: 'ndh', path: 'schuelerschaft.aspx?view=ndh', title: 'Неродной немецкий (ndH)', trend: true },
  { key: 'jgs', path: 'schuelerschaft.aspx?view=jgs', title: 'Ученики по классам', trend: false },
  { key: 'wohn', path: 'schuelerschaft.aspx?view=wohn', title: 'Откуда ученики (район проживания)', trend: false },
] as const;
export type PageKey = (typeof PAGES)[number]['key'];

/**
 * Ключевые цифры для сводки и для соседних школ: ячейка строки `row` (первая ячейка = подпись) в колонке `col`.
 * row = null — последняя строка таблицы; col = -1 — последняя ячейка. Значения — строки как на сайте.
 */
export const KEY_FIGURES = [
  { key: 'ausfall', page: 'vunt', row: 'Ausfall von Unterricht', col: 1, title: 'Ausfall уроков' },
  { key: 'ausfallBerlin', page: 'vunt', row: 'Ausfall von Unterricht in Berlin', col: 1, title: 'Ausfall — Берлин' },
  { key: 'bilanz', page: 'uvers', row: 'Bilanz in Stunden', col: 1, title: 'Баланс учит. часов' },
  { key: 'lehrkraefte', page: 'pers', row: 'Lehrkräfte', col: -1, title: 'Учителей' },
  { key: 'fehl', page: 'fehl', row: 'der Schule', col: 1, title: 'Пропуски, %' },
  { key: 'fehlUnent', page: 'fehl', row: 'der Schule', col: 2, title: 'Без уважит. причины, %' },
  { key: 'fehlBerlin', page: 'fehl', row: 'in Berlin', col: 1, title: 'Пропуски — Берлин, %' },
  { key: 'auslaender', page: 'nat', row: 'Insgesamt', col: -1, title: 'Иностр. граждан' },
  { key: 'schueler', page: 'ndh', row: null, col: 0, title: 'Учеников' },
  { key: 'ndh', page: 'ndh', row: null, col: -1, title: 'ndH, %' },
] as const satisfies readonly { key: string; page: PageKey; row: string | null; col: number; title: string }[];

export type PageData = {
  status: 'ok' | 'no_data';
  caption: string;
  rows: string[][]; // ячейка с colspan=n дополняется n-1 пустыми, чтобы колонки не съезжали
  headRows: number; // первые строки из одних <th>
  dataStand: string | null;
};

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

export function extractPage(html: string): PageData {
  const root = parse(html);
  // таблицу вырезаем до разбора: невалидная вложенность <p><div><table> на части страниц ломает дерево парсера
  const tableHtml = html.match(/<table[^>]*id="ContentPlaceHolderMenuListe_Grid[\s\S]*?<\/table>/)?.[0];
  const table = tableHtml ? parse(tableHtml).querySelector('table') : null;
  // в подписи незакрытый <b>…<b> — парсер теряет текст, берём регуляркой
  const caption = clean(parse(tableHtml?.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1] ?? '').text);
  const parsed = (table?.querySelectorAll('tr') ?? [])
    .map((tr) => ({
      head: tr.querySelectorAll('td').length === 0,
      cells: tr
        .querySelectorAll('th,td')
        .flatMap((c) => [clean(c.text), ...Array(Math.max(0, Number(c.getAttribute('colspan') ?? 1) - 1)).fill('')]),
    }))
    .filter((r) => r.cells.some(Boolean));
  const firstBody = parsed.findIndex((r) => !r.head);
  const noData = !table || parsed.length === 0 || table.text.includes('keine Daten verfügbar');
  const stand = root.querySelector('#ContentPlaceHolderMenuListe_HLinkKontaktGlobal')?.text.match(/Daten-Stand:\s*([^)]*)\)/);
  return {
    status: noData ? 'no_data' : 'ok',
    caption,
    rows: noData ? [] : parsed.map((r) => r.cells),
    headRows: noData ? 0 : firstBody === -1 ? parsed.length : firstBody,
    dataStand: clean(stand?.[1] ?? '') || null,
  };
}

/** Учебный год из подписи таблицы («Vertretungsunterricht 2025/26») или null. */
export const captionYear = (p: PageData) => p.caption.match(/\d{4}\/\d{2}/)?.[0] ?? null;

/** Сайт отдал таблицу другого года, чем запрошен (`&jahr=`) — для запрошенного года это «нет данных», а не чужие цифры. */
export const forYear = (p: PageData, year: string): PageData => {
  const y = captionYear(p);
  return y && y !== year ? { ...p, status: 'no_data', rows: [], headRows: 0 } : p;
};

/** Последние учебные годы, на которые у подстраницы есть ссылки `path&jahr=…`, от нового к старому. */
export function availableYears(html: string, path: string): string[] {
  const years = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)&(?:amp;)?jahr=(\d{4}\/\d{2})"/g)) if (m[1] === path) years.add(m[2]);
  return [...years].sort().reverse();
}

export function keyFigure(p: PageData | undefined, row: string | null, col: number): string | null {
  if (!p || p.status !== 'ok') return null;
  const r = row === null ? p.rows.at(-1) : p.rows.find((x) => x[0] === row);
  return r?.at(col) || null;
}

export type Profile = { name: string; fields: [label: string, value: string][] };

const PROFILE_FIELDS: [string, string][] = [
  ['Тип', 'lblSchulart'],
  ['Адрес', 'lblStrasse'],
  ['Город', 'lblOrt'],
  ['Телефон', 'lblTelefon'],
  ['E-mail', 'HLinkEMail'],
  ['Сайт', 'HLinkWeb'],
  ['Директор', 'lblLeitung'],
  ['Языки', 'lblSprachen'],
  ['Предложения (Ganztag, профиль)', 'lblAngebote'],
  ['Примечания', 'lblBemerkungenSchulzweig'],
  ['Оснащение', 'lblAusstattung'],
  ['Кружки (AG)', 'lblAGs'],
];

export function extractProfile(html: string): Profile {
  const root = parse(html);
  const text = (id: string) => clean(root.querySelector(`#ContentPlaceHolderMenuListe_${id}`)?.text ?? '');
  return {
    name: text('lblSchulname'),
    fields: PROFILE_FIELDS.map(([label, id]): [string, string] => [label, text(id)]).filter(([, v]) => v),
  };
}

export function extractInspections(html: string, baseUrl: string): { label: string; url: string }[] {
  return parse(html)
    .querySelectorAll('a[href*="DokLoader.aspx?Schulinspektion="]')
    .map((a: HTMLElement) => ({ label: clean(a.text), url: new URL(a.getAttribute('href')!, baseUrl) }))
    // в отчёт идут только https-ссылки на berlin.de — не javascript: и не чужой хост при подмене страницы
    .filter(({ url }) => url.protocol === 'https:' && url.hostname.endsWith('.berlin.de'))
    .map(({ label, url }) => ({ label, url: url.toString() }));
}
