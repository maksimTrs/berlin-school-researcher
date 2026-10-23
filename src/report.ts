import { readFileSync } from 'node:fs';
import { CATEGORIES, type Category, type Context } from './context.js';
import { KEY_FIGURES, keyFigure, PAGES, type PageKey } from './extract.js';
import { formatAddress, type Candidate, type Catchment, type School, type ZoneShare } from './geo.js';
import type { SchoolData, YearPage } from './portrait.js';
import type { AddressQuery, PlzQuery } from './schema.js';
import { EMOJI, scoreSchool, verdict } from './score.js';
import { startchancen } from './startchancen.js';

export type SchoolEntry = { school: School; role: 'main' | 'candidate' | 'neighbor'; data: SchoolData };

export type AddressResult = {
  input: AddressQuery;
  generatedAt: string;
  esbLayer: string;
  status: 'ok' | 'not_found';
  address: Candidate | null;
  alternatives: Candidate[];
  catchment: Catchment | null;
  schools: SchoolEntry[]; // [0] — main, полный блок
  warnings: string[]; // кандидаты и соседи, чей Schulporträt не загрузился
};

// ---------- Google Maps URLs (без ключа) ----------

type Point = { lat: number; lon: number };
const ll = (p: Point) => `${p.lat},${p.lon}`;
export const maps = {
  place: (p: Point) => `https://www.google.com/maps/search/?api=1&query=${ll(p)}`,
  walk: (from: Point, to: Point) =>
    `https://www.google.com/maps/dir/?api=1&origin=${ll(from)}&destination=${ll(to)}&travelmode=walking`,
  streetView: (p: Point) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll(p)}`,
};

// ---------- helpers ----------

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const link = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

export const noData = (year: string) => `н/д — нет данных на сайте за ${year}`;

const STATUS_TEXT: Record<Catchment['status'], { text: string; warn: boolean }> = {
  exact: { text: 'Школа найдена: единственная школа в зоне', warn: false },
  override: { text: 'Школа задана вручную (esbOverrides)', warn: false },
  matched_by_code: { text: 'В зоне несколько школ, выбрана по совпадению кода зоны и номера школы', warn: true },
  ambiguous: { text: 'В зоне несколько школ — закреплённую уточнить в Schulamt района', warn: true },
  no_school_in_zone: { text: 'Внутри зоны нет школы — показаны ближайшие, уточнить в Schulamt района', warn: true },
  no_zone: { text: 'Адрес не попал ни в одну зону — показаны ближайшие школы', warn: true },
};

function yearTable(yp: YearPage): string {
  if (yp.data.status === 'no_data') return `<p class="nd">${esc(noData(yp.year))}</p>`;
  const head = yp.data.rows.slice(0, yp.data.headRows);
  const body = yp.data.rows.slice(yp.data.headRows);
  const row = (r: string[], tag: string) => `<tr>${r.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`;
  return `<div class="scroll"><table>
    ${head.length ? `<thead>${head.map((r) => row(r, 'th')).join('')}</thead>` : ''}
    <tbody>${body.map((r) => row(r, 'td')).join('')}</tbody>
  </table></div>`;
}

function metricSection(key: PageKey, years: YearPage[] | undefined): string {
  const meta = PAGES.find((p) => p.key === key)!;
  if (!years) return '';
  const allMissing = years.every((y) => y.data.status === 'no_data');
  return `<section class="metric">
    <h3>${esc(meta.title)}</h3>
    ${'note' in meta ? `<p class="note">${esc(meta.note)}</p>` : ''}
    ${allMissing ? `<p class="warn">Сайт не публикует эту метрику для школы (н/д за все годы).</p>` : ''}
    <div class="years">${years
      .map(
        (y) => `<figure>
          <figcaption><b>${esc(y.year)}</b>${y.data.dataStand ? ` · данные на ${esc(y.data.dataStand)}` : ''}</figcaption>
          ${yearTable(y)}
        </figure>`,
      )
      .join('')}</div>
  </section>`;
}

/** year не задан — текущий год этой подстраницы (у подстраниц он может отличаться). */
function figure(data: SchoolData, k: (typeof KEY_FIGURES)[number], year?: string): string {
  const pages = data.pages[k.page];
  const yp = year ? pages?.find((y) => y.year === year) : pages?.[0];
  if (!yp) return year ? `<span class="nd">${esc(noData(year))}</span>` : '—';
  const v = keyFigure(yp.data, k.row, k.col);
  if (v === null) return `<span class="nd">${esc(noData(yp.year))}</span>`;
  // у Gemeinschaftsschule пропуски считаются по 7–10 классам — с 5–6 классами Grundschule напрямую не сравнить
  const grades = k.page === 'fehl' ? yp.data.caption.match(/K\d+-\d+/)?.[0] : undefined;
  return grades && grades !== 'K5-6' ? `${esc(v)} <small>(${esc(grades)})</small>` : esc(v);
}

function schoolLinks(s: School, data: SchoolData, home: Point, withInspections: boolean): string {
  return [
    link(data.portraitUrl, 'Schulporträt'),
    link(maps.place(s), 'Google Maps'),
    link(maps.walk(home, s), 'Пешком от адреса'),
    link(maps.streetView(s), 'Street View'),
    ...(withInspections ? data.inspections.map((i) => link(i.url, `PDF: ${i.label}`)) : []),
  ].join(' · ');
}

function scoreBlock(data: SchoolData, years: string[]): string {
  const metrics = scoreSchool(data);
  const v = verdict(metrics);
  const cell = (m: (typeof metrics)[number], year: string) => {
    const y = m.years.find((x) => x.year === year);
    if (!y || y.value === null) return `<span class="nd">${esc(noData(year))}</span>`;
    const mark = y.worse === null ? '' : y.worse ? '<b class="bad">✗</b> ' : '<span class="good">✓</span> ';
    return `${mark}${esc(y.value + m.unit)}${y.ref ? ` <small>средн. ${esc(y.ref)}</small>` : ''}`;
  };
  return `<div class="score">
    <p class="verdict">${esc(v.text)}</p>
    <div class="scroll"><table class="summary">
      <thead><tr><th>Показатель</th>${years.map((y) => `<th>${esc(y)}</th>`).join('')}</tr></thead>
      <tbody>${metrics
        .map((m) => `<tr><th scope="row">${EMOJI[m.light]} ${esc(m.title)}</th>${years.map((y) => `<td>${cell(m, y)}</td>`).join('')}</tr>`)
        .join('')}</tbody>
    </table></div>
    <p class="note">✗ — хуже средней по типу школ с сайта (учителя — дефицит часов). 🟢 нет ✗ · 🟡 есть ✗ · 🔴 ✗ в большинстве лет. Итог — по худшей строке.</p>
  </div>`;
}

const inStartchancen = (s: School) => startchancen().schools.includes(s.bsn);

// критерии отбора и что получает школа — по FAQ berlin.de (проверено 2026-10-23)
const STARTCHANCEN_FAQ = 'https://www.berlin.de/sen/bildung/unterstuetzung/startchancen-programm/faq/';

function startchancenNote(s: School): string {
  const source = `<small>${link(startchancen().source, 'Список berlin.de')} на ${esc(startchancen().fetchedAt)}</small>`;
  if (!inStartchancen(s)) return `<p class="note">ℹ️ Не в программе Startchancen. ${source}</p>`;
  return `<div class="startchancen">
    <p>🔶 <b>Школа в программе Startchancen</b>: больше учеников из социально неблагополучных семей, дополнительные деньги и персонал. ${source}</p>
    <details><summary>Что это значит</summary>
      <p>Программа Bund и Länder для школ «в сложной социальной ситуации»: с августа 2024 года, на 10 лет.</p>
      <p>Школы отбирали по доле учеников из семей с правом на бесплатные учебники или Bildung und Teilhabe (низкий доход),
        доле учеников неродного немецкого происхождения, инклюзии, доле второгодников, статус-индексу района и результатам VERA.
        Неродной немецкий и иностранное гражданство этой школы — в ключевых цифрах ниже.</p>
      <p>Школа получает деньги на здание, свой бюджет на развитие и дополнительный персонал (multiprofessionelle Teams: соцработники, работа с семьями).</p>
      <p>${link(STARTCHANCEN_FAQ, 'FAQ berlin.de: критерии отбора')}</p>
    </details>
  </div>`;
}

const SOURCE: Record<Context['items'][number]['source'], string> = { official: '', mirror: 'копия документа ведомства · ' };

// что такой факт обычно значит для ребёнка — общий текст на тему, а не вывод о конкретной школе
const MEANING: Record<Category, string> = {
  capacity:
    'Школа заполнена сверх расчёта. Обычно под классы занимают кабинеты или комнаты продлёнки, классы полнее. Ребёнка, который приходит не к началу учебного года, могут направить в другую школу, где есть место.',
  construction:
    'Стройка идёт годами: шум, временные модули, закрытая часть двора. После неё — больше комнат и новое оснащение. Важно, какой этап придётся на годы ребёнка в школе.',
  welcome_classes:
    'Willkommensklasse — отдельная группа для детей без немецкого до перехода в обычный класс. Если в школе её нет, ребёнка берут в обычный класс с дополнительными уроками немецкого (DaZ) или направляют в школу, где группа есть; решает Schulamt района.',
  catchment:
    'Меняются границы школьной зоны: адрес может отойти к другой школе. Действует зона того года, когда ребёнок поступает, — проверьте её заново перед подачей документов.',
  leadership:
    'Новый директор или вакансия: в первые годы школа может менять порядки — продлёнку, профиль, организацию классов. Само по себе это не плюс и не минус.',
  afterschool:
    'Hort — продлёнка после уроков. Если у неё нет своих комнат, дети остаются в тех же классах, где учились утром, а мест в продлёнке может быть меньше, чем желающих.',
};

/** Проверенные кодом факты из официальных источников: одна строка на факт, цитата — под спойлером, пояснение — по темам. */
function contextBlock(ctx: Context | null): string {
  if (!ctx) return '';
  const head = `<p class="note">Проверено ${esc(ctx.checkedAt.slice(0, 10))}: публикации с ${esc(ctx.window.publishedFrom)} и планы до ${esc(ctx.window.plannedTo)}, только официальные источники, цитаты сверены с документом.</p>`;
  if (!ctx.items.length) return `<div class="context"><h3>Что известно из официальных источников</h3><p>Сообщений о школе за этот период не найдено.</p>${head}</div>`;
  return `<div class="context">
    <h3>Что известно из официальных источников</h3>
    <ul>${ctx.items
      .map(
        (i) => `<li>
          <b>${esc(i.published)}</b> · ${esc(CATEGORIES[i.category])}: ${esc(i.summaryRu)}${i.planned ? ` <small>(план: ${esc(i.planned)})</small>` : ''}
          <small>${esc(SOURCE[i.source])}${link(i.url, i.host)}</small>
          <details><summary>Цитата</summary><blockquote lang="de">${esc(i.quote)}</blockquote></details>
        </li>`,
      )
      .join('')}</ul>
    <details><summary>Что это обычно значит</summary>${[...new Set(ctx.items.map((i) => i.category))]
      .map((c) => `<p><b>${esc(CATEGORIES[c])}.</b> ${esc(MEANING[c])}</p>`)
      .join('')}</details>
    ${head}
  </div>`;
}

/** Поле профиля, которое опровергает свежее официальное сообщение, — с пометкой рядом. */
function profileValue(label: string, value: string, ctx: Context | null): string {
  const against = ctx?.items.filter((i) => i.contradicts === label) ?? [];
  return `${esc(value)}${against
    .map((i) => `<br><small class="bad">⚠️ Возможно, устарело: ${esc(i.published)} — ${esc(i.summaryRu)}</small>`)
    .join('')}`;
}

const ROLE: Record<SchoolEntry['role'], string> = { main: 'закреплённая', candidate: 'кандидат', neighbor: 'ближайшая' };

// ---------- render ----------

/** ctx — проверенный context.json закреплённой школы, если его собирали. */
export function renderReport(r: AddressResult, ctx: Context | null = null): string {
  const addr = r.address!;
  const c = r.catchment!;
  const [main, ...others] = r.schools;
  const st = STATUS_TEXT[c.status];
  const years = (main.data.pages.vunt ?? []).map((y) => y.year);
  const mainCtx = ctx?.bsn === main.school.bsn ? ctx : null;

  const summary = `<div class="scroll"><table class="summary">
    <thead><tr><th>Показатель</th>${years.map((y) => `<th>${esc(y)}</th>`).join('')}</tr></thead>
    <tbody>${KEY_FIGURES.map(
      (k) => `<tr><th scope="row">${esc(k.title)}</th>${years.map((y) => `<td>${figure(main.data, k, y)}</td>`).join('')}</tr>`,
    ).join('')}</tbody>
  </table></div>`;

  const othersTable = others.length
    ? `<section>
      <h2>Другие школы рядом — текущий учебный год</h2>
      <div class="scroll"><table class="summary">
        <thead><tr><th>Школа</th><th>Роль</th><th>Расстояние</th>${KEY_FIGURES.map((k) => `<th>${esc(k.title)}</th>`).join('')}</tr></thead>
        <tbody>${others
          .map(
            (o) => `<tr>
              <th scope="row">${esc(o.school.name)} <small>${esc(o.school.bsn)}${inStartchancen(o.school) ? ' · 🔶 Startchancen' : ''}</small><br><small>${schoolLinks(o.school, o.data, addr, false)}</small></th>
              <td>${ROLE[o.role]}</td><td>${o.school.distanceM ?? '—'} м</td>
              ${KEY_FIGURES.map((k) => `<td>${figure(o.data, k)}</td>`).join('')}
            </tr>`,
          )
          .join('')}</tbody>
      </table></div>
    </section>`
    : '';

  const shots = main.data.screenshots
    .map(
      (s) => `<details><summary>${esc(s.title)}</summary>
        <img loading="lazy" alt="Скриншот: ${esc(s.title)}" src="data:image/png;base64,${readFileSync(s.file).toString('base64')}">
      </details>`,
    )
    .join('');

  const title = `Школа — ${addr.street} ${addr.house}${addr.suffix ?? ''}, ${addr.plz}`;

  return page(title, `<main>
<header style="display:grid;gap:6px">
  <span class="eyebrow">Einschulbereich ${esc(c.esb ?? '—')} · слой ${esc(r.esbLayer)} · отчёт от ${esc(r.generatedAt.slice(0, 10))}</span>
  <h1>${esc(main.data.profile.name || main.school.name)}</h1>
  <div class="meta">Адрес: <b>${esc(formatAddress(addr))}</b> (${esc(addr.bezirk)})${r.input.raw ? ` · ввод: «${esc(r.input.raw)}»` : ''}</div>
</header>

${st.warn ? `<p class="warn">⚠️ ${esc(st.text)}.</p>` : `<p class="meta">${esc(st.text)}.</p>`}
${
  r.alternatives.length
    ? `<p class="warn">⚠️ Адрес неоднозначен, взят первый вариант. Другие: ${r.alternatives.map((a) => esc(formatAddress(a))).join('; ')}.</p>`
    : ''
}

<section>
  <h2>Закреплённая школа · ${esc(main.school.bsn)}</h2>
  <div>${schoolLinks(main.school, main.data, addr, true)}</div>
  <p class="meta">Расстояние от адреса по прямой: ${main.school.distanceM ?? '—'} м</p>
  ${startchancenNote(main.school)}
  ${scoreBlock(main.data, years)}
  ${contextBlock(mainCtx)}
  <dl>${main.data.profile.fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${profileValue(k, v, mainCtx)}</dd>`).join('')}</dl>
</section>

<section>
  <h2>Ключевые цифры за ${years.length} уч. года</h2>
  ${summary}
  <p class="note">Значения — как на bildung.berlin.de, без пересчёта. Дата данных у каждого блока своя (см. ниже).</p>
</section>

<section>
  <h2>Подробно по годам</h2>
  ${PAGES.map((p) => metricSection(p.key, main.data.pages[p.key])).join('')}
</section>

${othersTable}
${r.warnings.map((w) => `<p class="warn">⚠️ ${esc(w)}</p>`).join('')}

<section>
  <h2>Скриншоты Schulporträt (текущий год)</h2>
  ${shots}
</section>
</main>
`);
}

/** Общая оболочка отчётов: head, шрифты, стили. */
function page(title: string, body: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700&family=Source+Sans+3:wght@400;600&display=swap">
<style>
/* Layout: одна колонка-документ, таблицы прокручиваются внутри себя */
:root {
  --bg: #f8f9f7; --surface: #ffffff; --fg: #1c2321; --muted: #5b6662; --line: #d9dfdc;
  --accent: #0a6a6a; --warn: #9a4a07; --warn-bg: #fcf1e2;
  --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif;
  --body: 'Source Sans 3', 'Segoe UI', Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #121615; --surface: #1a201e; --fg: #e5ebe8; --muted: #9aa6a1; --line: #2c3532;
  --accent: #5cc6c1; --warn: #f0a560; --warn-bg: #2d2116; color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #121615; --surface: #1a201e; --fg: #e5ebe8; --muted: #9aa6a1; --line: #2c3532;
  --accent: #5cc6c1; --warn: #f0a560; --warn-bg: #2d2116; color-scheme: dark; }
body { background: var(--bg); color: var(--fg); font: 16px/1.5 var(--body);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 48px; }
main { max-width: 1100px; margin: 0 auto; display: grid; gap: 28px; }
h1, h2, h3 { font-family: var(--display); line-height: 1.2; text-wrap: balance; margin: 0; }
h1 { font-size: 1.75rem; } h2 { font-size: 1.3rem; } h3 { font-size: 1.05rem; }
section { display: grid; gap: 12px; min-width: 0; }
a { color: var(--accent); }
small, .note, figcaption, .meta { color: var(--muted); font-size: .875rem; }
.eyebrow { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.warn { background: var(--warn-bg); color: var(--warn); padding: 10px 12px; border-radius: 6px; margin: 0; }
.nd { color: var(--muted); font-style: italic; }
.scroll { overflow-x: auto; min-width: 0; }
table { border-collapse: collapse; font-variant-numeric: tabular-nums; background: var(--surface); }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
thead th { font-weight: 600; background: var(--bg); }
.summary td { white-space: nowrap; }
.summary td .nd { white-space: normal; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--muted); } dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.years { display: flex; flex-wrap: wrap; gap: 16px; }
.years figure { margin: 0; display: grid; gap: 6px; min-width: 0; max-width: 100%; }
.score { display: grid; gap: 8px; min-width: 0; }
.score p { margin: 0; }
.verdict { font: 600 1.1rem/1.3 var(--display); }
.bad { color: var(--warn); } .good { color: var(--accent); }
.metric { border-top: 1px solid var(--line); padding-top: 16px; }
details { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px; background: var(--surface); }
summary { cursor: pointer; font-weight: 600; }
details img { display: block; margin-top: 8px; max-width: 100%; height: auto; }
.startchancen details p { margin: 8px 0 0; }
.context { display: grid; gap: 8px; min-width: 0; }
.context ul { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
.context p, .context details { margin: 0; }
.context details { margin-top: 4px; padding: 4px 10px; }
.context details p { margin: 6px 0 0; }
.context blockquote { margin: 6px 0 2px; color: var(--muted); }
@media (max-width: 560px) { dl { grid-template-columns: 1fr; } dt { margin-top: 6px; } }
</style>
${body}`;
}

// ---------- PLZ ----------

export type PlzSchool = { school: School; data: SchoolData };

export type PlzResult = {
  input: PlzQuery;
  generatedAt: string;
  esbLayer: string;
  status: 'ok' | 'not_found';
  addresses: number; // все адреса PLZ (или улицы в нём) в реестре
  zones: ZoneShare[]; // от большей доли адресов к меньшей
  schools: PlzSchool[]; // школы всех зон без повторов
  warnings: string[]; // школы, чей Schulporträt не загрузился
};

export const share = (n: number, total: number) => `${Math.round((100 * n) / total)} %`;

export const plzTitle = (q: PlzQuery) => (q.street ? `${q.street}, ${q.plz}` : `PLZ ${q.plz}`);

export function renderPlzReport(r: PlzResult): string {
  const data = new Map(r.schools.map((s) => [s.school.bsn, s.data]));
  const years = (r.schools[0]?.data.pages.vunt ?? []).map((y) => y.year);
  const outside = r.addresses - r.zones.reduce((n, z) => n + z.addresses, 0);
  // имя из WFS: в Schulporträt к названию приписан номер школы, а он в отчёте и так стоит рядом
  const schoolName = (s: School) => s.name;
  const marker = (s: School) => {
    const d = data.get(s.bsn);
    return d ? esc(verdict(scoreSchool(d)).text) : '<span class="nd">Schulporträt не загрузился</span>';
  };

  // две колонки без .summary: текст переносится, и маркер виден на телефоне без прокрутки
  const zonesTable = `<table>
    <thead><tr><th>Зона · адресов</th><th>Школа и маркер</th></tr></thead>
    <tbody>${r.zones
      .map((z) => {
        const st = STATUS_TEXT[z.status];
        return z.schools
          .map(
            (s, i) => `<tr>
              ${i === 0 ? `<th scope="row" rowspan="${z.schools.length}">${esc(z.esb)}<br><small>${z.addresses} · ${share(z.addresses, r.addresses)}</small>${st.warn ? `<br><small class="bad">⚠️ ${esc(st.text)}</small>` : ''}</th>` : ''}
              <td>${esc(schoolName(s))} <small>${esc(s.bsn)}${inStartchancen(s) ? ' · 🔶 Startchancen' : ''}</small><br>${marker(s)}</td>
            </tr>`,
          )
          .join('');
      })
      .join('')}</tbody>
  </table>`;

  const schoolSections = r.schools
    .map(
      ({ school: s, data: d }) => `<section class="metric">
        <h3>${esc(schoolName(s))} · ${esc(s.bsn)}</h3>
        <div>${[link(d.portraitUrl, 'Schulporträt'), link(maps.place(s), 'Google Maps')].join(' · ')}</div>
        ${startchancenNote(s)}
        ${scoreBlock(d, (d.pages.vunt ?? []).map((y) => y.year))}
      </section>`,
    )
    .join('');

  const figuresTable = `<div class="scroll"><table class="summary">
    <thead><tr><th>Школа</th>${KEY_FIGURES.map((k) => `<th>${esc(k.title)}</th>`).join('')}</tr></thead>
    <tbody>${r.schools
      .map((s) => `<tr><th scope="row">${esc(schoolName(s.school))} <small>${esc(s.school.bsn)}</small></th>${KEY_FIGURES.map((k) => `<td>${figure(s.data, k)}</td>`).join('')}</tr>`)
      .join('')}</tbody>
  </table></div>`;

  // с улицей во вводе дома — главный ответ «какой номер в какой зоне», их раскрываем сразу
  const streets = r.zones
    .map(
      (z) => `<details${r.input.street ? ' open' : ''}><summary>Зона ${esc(z.esb)} — адресов: ${z.addresses}</summary>
        ${z.streets.map((s) => `<p><b>${esc(s.street)}</b>: ${esc(s.houses.join(', '))}</p>`).join('')}
      </details>`,
    )
    .join('');

  const where = r.input.street ? 'Адреса улицы в этом PLZ' : 'Адреса PLZ';
  return page(`Школы — ${plzTitle(r.input)}`, `<main>
<header style="display:grid;gap:6px">
  <span class="eyebrow">Поиск по PLZ · слой ${esc(r.esbLayer)} · отчёт от ${esc(r.generatedAt.slice(0, 10))}</span>
  <h1>Школы — ${esc(plzTitle(r.input))}</h1>
  <div class="meta">${where} в реестре: <b>${r.addresses}</b> · зон Einschulbereich: <b>${r.zones.length}</b></div>
</header>

${
  r.zones.length > 1
    ? `<p class="warn">⚠️ ${where} делятся между ${r.zones.length} зонами — закреплённая школа зависит от номера дома. Узнайте точный адрес у арендодателя и проверьте его через /school.</p>`
    : `<p class="meta">Все адреса — в одной зоне.</p>`
}
${outside ? `<p class="warn">⚠️ Адресов вне всех зон: ${outside}.</p>` : ''}

<section>
  <h2>Зоны и школы</h2>
  ${zonesTable}
  <p class="note">Доля — от числа адресов (домов) в реестре, не квартир: особняк и дом на 200 квартир считаются одинаково. Это не вероятность, что квартира попадёт в зону. Маркер — за ${years.length} уч. года, как в отчёте по адресу.</p>
</section>

<section>
  <h2>Школы</h2>
  ${schoolSections}
</section>

<section>
  <h2>Ключевые цифры — текущий учебный год</h2>
  ${figuresTable}
  <p class="note">Значения — как на bildung.berlin.de, без пересчёта.</p>
</section>

<section>
  <h2>Улицы и дома по зонам</h2>
  ${streets}
</section>

${r.warnings.map((w) => `<p class="warn">⚠️ ${esc(w)}</p>`).join('')}
</main>
`);
}
