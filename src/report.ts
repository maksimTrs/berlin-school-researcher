import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { CATEGORIES, longTerm, type Category, type Context, type PlzContext } from './context.js';
import { fehlGrades, KEY_FIGURES, keyFigure, PAGES, type PageKey } from './extract.js';
import { formatAddress, type Candidate, type Catchment, type ExcludedByOrtsteil, type School, type ZoneShare } from './geo.js';
import type { SchoolData, YearPage } from './portrait.js';
import type { AddressQuery, PlzQuery } from './schema.js';
import { EMOJI, scoreSchool, verdict } from './score.js';
import { schulamt } from './schulamt.js';
import { startchancen } from './startchancen.js';
import { zuzug } from './zuzug.js';

// joint — другая закреплённая школа общей зоны: маркер и факты, как у основной, без скриншотов
export type SchoolEntry = { school: School; role: 'main' | 'joint' | 'candidate' | 'neighbor'; data: SchoolData };

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
  joint: { text: 'Общая зона нескольких школ (gemeinsamer ESB по справочнику округа): закреплены все; в какую возьмут — решают школы и Schulamt', warn: true },
  code_mismatch: { text: 'В зоне одна школа, но её номер не совпадает с кодом зоны: вероятно, она закреплена за соседней зоной, а школа этой зоны стоит за её границей — уточнить в Schulamt района', warn: true },
  matched_by_code: { text: 'В зоне несколько школ, выбрана по совпадению кода зоны и номера школы', warn: true },
  ambiguous: { text: 'В зоне несколько школ — закреплённую уточнить в Schulamt района', warn: true },
  no_school_in_zone: { text: 'Внутри зоны нет школы — показаны ближайшие, уточнить в Schulamt района', warn: true },
  no_zone: { text: 'Адрес не попал ни в одну зону — показаны ближайшие школы', warn: true },
};

/** Школа стоит в зоне, но своей зоны у неё нет (config.schoolsWithoutZone): семье важно знать, что она рядом, но не закреплена. */
const withoutZoneNote = (schools: School[] = []) =>
  schools
    .map((s) => `<p class="meta">ℹ️ В зоне стоит и ${esc(s.name)} (${esc(s.bsn)}), но своей зоны Einschulbereich у неё нет — в закреплённые не входит. ${esc(config.schoolsWithoutZone[s.bsn] ?? '')}</p>`)
    .join('');

// заголовок основного блока: ближайшая школа без закрепления не называется закреплённой
const MAIN_TITLE: Record<Catchment['status'], string> = {
  exact: 'Закреплённая школа',
  override: 'Закреплённая школа',
  joint: 'Одна из закреплённых школ общей зоны',
  code_mismatch: 'Школа внутри зоны — закреплённая не определена',
  matched_by_code: 'Вероятно закреплённая школа',
  ambiguous: 'Ближайшая из школ зоны — закреплённая не определена',
  no_school_in_zone: 'Ближайшая школа — закреплённая не определена',
  no_zone: 'Ближайшая школа — закреплённая не определена',
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
  const grades = fehlGrades(k, yp.data);
  return grades ? `${esc(v)} <small>(${esc(grades)})</small>` : esc(v);
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

/** Переезд в Берлин посреди учебного года — цитаты SenBJF из снимка config/zuzug.json, свёрнуто: нужно не всем. */
function zuzugBlock(): string {
  let z: ReturnType<typeof zuzug>;
  try {
    z = zuzug();
  } catch (e) {
    // испорченный снимок не должен стоить отчёта после полного прогона браузера — тогда без блока
    console.warn(`config/zuzug.json: не читается (${(e as Error).message.split('\n')[0]}) — отчёт без блока о переезде`);
    return '';
  }
  return `<details class="zuzug"><summary>🧳 Переезд в Берлин посреди учебного года — как дают место в школе</summary>
    <ul>${z.items
      .map((i) => `<li>${esc(i.summaryRu)} <small>${link(i.url, new URL(i.url).pathname.endsWith('.pdf') ? 'PDF SenBJF' : 'berlin.de')}, ${esc(i.published ?? 'без даты на странице')}</small></li>`)
      .join('')}</ul>
    <p>${z.links.map((l) => link(l.url, l.label)).join('<br>')}</p>
    <p class="note">Цитаты сверены с документами ${esc(z.checkedAt)}; общие правила Берлина, не решение по конкретной школе.</p>
  </details>`;
}

/** Куда обращаться: Schulamt и Schulaufsicht округа — снимок config/schulamt.json, роль каждого — пересказ цитаты SenBJF. */
function officesBlock(bezirke: string[]): string {
  let s: ReturnType<typeof schulamt>;
  try {
    s = schulamt();
  } catch (e) {
    // испорченный снимок не должен стоить отчёта после полного прогона браузера — тогда без блока
    console.warn(`config/schulamt.json: не читается (${(e as Error).message.split('\n')[0]}) — отчёт без Schulamt`);
    return '';
  }
  const office = (title: string, o: { url: string; address: string | null; email: string | null }) =>
    `<p>${title}: ${[o.address ? esc(o.address) : '<span class="nd">н/д — адреса нет на странице</span>', o.email && `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>`, link(o.url, 'berlin.de')].filter(Boolean).join(' · ')}</p>`;
  const rows = bezirke.map((b) => {
    const e = s.bezirke[b];
    if (!e) return `<p class="nd">н/д — нет Schulamt округа «${esc(b)}» в config/schulamt.json</p>`;
    return office(`🏛 <b>Schulamt ${esc(b)}</b>`, e.schulamt) + office(`🔎 <b>Schulaufsicht ${esc(b)}</b>`, e.schulaufsicht);
  });
  if (!rows.length) return '';
  return `<div class="offices">
    <p class="meta">${esc(s.roles.schulamt.summaryRu)} ${esc(s.roles.schulaufsicht.summaryRu)} <small>${link(s.roles.schulamt.url, 'SenBJF')}, ${link(s.roles.schulaufsicht.url, 'SenBJF')}</small></p>
    ${rows.join('')}
    <small>Адреса и ящики — со страниц ведомств на ${esc(s.checkedAt)}, без имён и личных номеров: они на странице berlin.de.</small>
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
    'Willkommensklasse — отдельная группа для детей без немецкого до перехода в обычный класс. Кого и в какой класс берут при переезде, кто назначает школу — в блоке «Переезд в Берлин посреди учебного года» (цитаты SenBJF).',
  catchment:
    'Меняются границы школьной зоны: адрес может отойти к другой школе. Действует зона того года, когда ребёнок поступает, — проверьте её заново перед подачей документов.',
  leadership:
    'Новый директор или вакансия: в первые годы школа может менять порядки — продлёнку, профиль, организацию классов. Само по себе это не плюс и не минус.',
  afterschool:
    'Hort — продлёнка после уроков. Если у неё нет своих комнат, дети остаются в тех же классах, где учились утром, а мест в продлёнке может быть меньше, чем желающих.',
};

/** Строки фактов и пояснение по их темам; цитаты — только в context.json. Дальние планы стройки — короткой строкой в конце. */
function factsList(ctx: Context): string {
  const near = ctx.items.filter((i) => !longTerm(i, ctx.window.plannedTo));
  const far = ctx.items.filter((i) => longTerm(i, ctx.window.plannedTo));
  const source = (i: Context['items'][number]) => `<small>${esc(SOURCE[i.source])}${link(i.url, i.host)}</small>`;
  return `${
    near.length
      ? `<ul>${near
          .map(
            (i) => `<li><b>${esc(i.published)}</b> · ${esc(CATEGORIES[i.category])}: ${esc(i.summaryRu)}${i.planned ? ` <small>(план: ${esc(i.planned)})</small>` : ''}
          ${source(i)}</li>`,
          )
          .join('')}</ul>
    <details><summary>💡 Что это обычно значит</summary>${[...new Set(near.map((i) => i.category))]
      .map((c) => `<p><b>${esc(CATEGORIES[c])}.</b> ${esc(MEANING[c])}</p>`)
      .join('')}</details>`
      : ''
  }${
    far.length
      ? `<p class="far-plans"><b>🗓 Дальние планы</b> — стройка начнётся позже ${esc(ctx.window.plannedTo)}, может прийтись на годы учёбы:</p>
    <ul>${far.map((i) => `<li><b>${esc(i.planned!)}</b> · ${esc(i.summaryRu)} ${source(i)}</li>`).join('')}</ul>`
      : ''
  }`;
}

const checkedNote = (ctx: Context) =>
  `<p class="note">Проверено ${esc(ctx.checkedAt.slice(0, 10))}: публикации с ${esc(ctx.window.publishedFrom)} и планы до ${esc(ctx.window.plannedTo)}${ctx.window.constructionTo ? ` (стройка — до ${esc(ctx.window.constructionTo)})` : ''}, только официальные источники, каждый факт сверен с документом.</p>`;

/** Раздел фактов о закреплённой школе в отчёте по адресу. */
function contextBlock(ctx: Context | null, school?: string): string {
  if (!ctx) return '';
  return `<section class="context">
  <h2>Что известно из официальных источников${school ? ` — ${esc(school)}` : ''}</h2>
  ${ctx.items.length ? factsList(ctx) : '<p>Сообщений о школе за этот период не найдено.</p>'}
  ${checkedNote(ctx)}
</section>`;
}

/** Факты о школе в отчёте по PLZ — внутри блока школы, без своего заголовка раздела. */
function plzFacts(ctx: Context | undefined): string {
  if (!ctx) return '';
  if (!ctx.items.length) return '<p class="note">Официальных сообщений о школе за период не найдено.</p>';
  return `<div class="context"><p><b>Что известно из официальных источников</b></p>${factsList(ctx)}</div>`;
}

/** Поле профиля, которое опровергает свежее официальное сообщение, — с пометкой рядом. */
function profileValue(label: string, value: string, ctx: Context | null): string {
  const against = ctx?.items.filter((i) => i.contradicts === label) ?? [];
  return `${esc(value)}${against
    .map((i) => `<br><small class="bad">⚠️ Возможно, устарело: ${esc(i.published)} — ${esc(i.summaryRu)}</small>`)
    .join('')}`;
}

const ROLE: Record<SchoolEntry['role'], string> = {
  main: 'закреплённая',
  joint: 'закреплённая (общая зона)',
  candidate: 'кандидат',
  neighbor: 'ближайшая',
};

// ---------- render ----------

/** ctx — проверенный context.json: закреплённой школы или (общая зона) каждой закреплённой школы, если его собирали. */
export function renderReport(r: AddressResult, ctx: Context | PlzContext | null = null): string {
  const addr = r.address!;
  const c = r.catchment!;
  const [main, ...others] = r.schools;
  const st = STATUS_TEXT[c.status];
  const years = (main.data.pages.vunt ?? []).map((y) => y.year);
  const facts = new Map((ctx ? ('schools' in ctx ? ctx.schools : [ctx]) : []).map((x) => [x.bsn, x]));
  const mainCtx = facts.get(main.school.bsn) ?? null;

  // другие школы общей зоны закреплены так же, как основная: маркер за годы тренда и проверенные факты
  const jointSections = others
    .filter((o) => o.role === 'joint')
    .map(
      (o) => `<section>
  <h2>Тоже закреплённая школа общей зоны · ${esc(o.school.bsn)}</h2>
  <p><b>${esc(o.data.profile.name || o.school.name)}</b></p>
  <div>${schoolLinks(o.school, o.data, addr, false)}</div>
  <p class="meta">Расстояние от адреса по прямой: ${o.school.distanceM ?? '—'} м</p>
  ${startchancenNote(o.school)}
  ${scoreBlock(o.data, (o.data.pages.vunt ?? []).map((y) => y.year))}
</section>
${contextBlock(facts.get(o.school.bsn) ?? null, o.data.profile.name || o.school.name)}`,
    )
    .join('');

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
  ${officesBlock([addr.bezirk])}
</header>

${st.warn ? `<p class="warn">⚠️ ${esc(st.text)}${c.status === 'joint' ? `: ${c.schools.map((s) => `${esc(s.name)} (${esc(s.bsn)})`).join(', ')}` : ''}.</p>` : `<p class="meta">${esc(st.text)}.</p>`}
${withoutZoneNote(c.withoutZone)}
${
  r.alternatives.length
    ? `<p class="warn">⚠️ Адрес неоднозначен, взят первый вариант. Другие: ${r.alternatives.map((a) => esc(formatAddress(a))).join('; ')}.</p>`
    : ''
}

<section>
  <h2>${MAIN_TITLE[c.status]} · ${esc(main.school.bsn)}</h2>
  <div>${schoolLinks(main.school, main.data, addr, true)}</div>
  <p class="meta">Расстояние от адреса по прямой: ${main.school.distanceM ?? '—'} м</p>
  ${startchancenNote(main.school)}
  ${scoreBlock(main.data, years)}
</section>

${contextBlock(mainCtx, c.status === 'joint' ? main.data.profile.name || main.school.name : undefined)}

${jointSections}

${zuzugBlock()}

<section>
  <h2>Профиль и контакты школы</h2>
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
  --accent: #0a6a6a; --warn: #9a4a07; --warn-bg: #fcf1e2; --zone-fill: #e8f1f0; --zone-hover: #cfe3e1; --basemap-filter: none;
  --display: 'Archivo', 'Helvetica Neue', Arial, sans-serif;
  --body: 'Source Sans 3', 'Segoe UI', Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #121615; --surface: #1a201e; --fg: #e5ebe8; --muted: #9aa6a1; --line: #2c3532;
  --accent: #5cc6c1; --warn: #f0a560; --warn-bg: #2d2116; --zone-fill: #1d2a28; --zone-hover: #26403d; --basemap-filter: invert(.88) contrast(.9); color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #121615; --surface: #1a201e; --fg: #e5ebe8; --muted: #9aa6a1; --line: #2c3532;
  --accent: #5cc6c1; --warn: #f0a560; --warn-bg: #2d2116; --zone-fill: #1d2a28; --zone-hover: #26403d; --basemap-filter: invert(.88) contrast(.9); color-scheme: dark; }
body { background: var(--bg); color: var(--fg); font: 16px/1.5 var(--body);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 24px 48px; }
main { max-width: 1100px; margin: 0 auto; display: grid; gap: 28px; }
h1, h2, h3 { font-family: var(--display); line-height: 1.2; text-wrap: balance; margin: 0; }
h1 { font-size: 1.75rem; } h2 { font-size: 1.3rem; } h3 { font-size: 1.05rem; }
section { display: grid; gap: 12px; min-width: 0; }
main > p, section > p { margin: 0; } /* отступы задаёт gap сетки, а не поля абзацев */
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
.context p { margin: 0; }
.context details p { margin: 6px 0 0; }
.zone-map { margin: 8px 0 0; display: grid; gap: 6px; }
.zone-map svg { display: block; width: 100%; min-width: 640px; height: auto; max-height: 80vh; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; }
.zone-map .zone { fill: var(--zone-fill); stroke: var(--accent); stroke-width: 2; fill-rule: evenodd; }
.zone-map .zone:hover { fill: var(--zone-hover); }
.zone-map .basemap { filter: var(--basemap-filter); }
.with-basemap .zone { fill: var(--accent); fill-opacity: .1; stroke-width: 3; }
.with-basemap .zone:hover { fill: var(--accent); fill-opacity: .22; }
.with-basemap .dots circle { fill: var(--accent); opacity: .7; }
.zone-map .dots circle { fill: var(--muted); opacity: .55; pointer-events: none; }
.zone-map .school circle { fill: var(--fg); stroke: var(--surface); stroke-width: 2; }
.zone-map text { font: 600 14px var(--body); fill: var(--fg); paint-order: stroke; stroke: var(--surface); stroke-width: 4px; stroke-linejoin: round; }
.zone-map .label { font: 700 20px var(--display); text-anchor: middle; dominant-baseline: middle; pointer-events: none; }
.zuzug ul { margin: 8px 0 0; padding-left: 20px; display: grid; gap: 6px; }
.zuzug p { margin: 8px 0 0; }
.offices { display: grid; gap: 6px; font-size: .875rem; }
.offices p { margin: 0; }
.plz-zones { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
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
  excludedByOrtsteil?: ExcludedByOrtsteil | null; // PLZ + район: дома PLZ в других районах; в старых result.json поля нет
};

// 1 дом из 775 — не «0 %», а 429 из 430 — не «100 %»: рядом есть другая зона, пусть и маленькая
export const share = (n: number, total: number) => {
  const pct = Math.round((100 * n) / total);
  return n > 0 && pct === 0 ? '<1 %' : n < total && pct === 100 ? '>99 %' : `${pct} %`;
};

/** «PLZ 10439», «Schivelbeiner Straße, 10439», «Friedenau», «Friedenau, PLZ 12161», «Handjerystraße, Friedenau». */
export const plzTitle = (q: PlzQuery) => {
  const area = q.ortsteil ? [q.ortsteil, q.plz && `PLZ ${q.plz}`] : [q.street ? q.plz : `PLZ ${q.plz}`];
  return [q.street, ...area].filter(Boolean).join(', ');
};

// ---------- карта зон ----------

export const MAP_W = 1000;

/**
 * Кадр карты зон: дома запроса и школы с полями, градус долготы сжат до широты Берлина.
 * bbox [lon0, lat0, lon1, lat1] — ровно то, что видно в SVG 0..MAP_W × 0..h: по нему же скачивают подложку.
 */
export function mapFrame(zones: ZoneShare[]) {
  const withPoints = zones.filter((z) => z.points?.length && z.geometry);
  if (!withPoints.length) return null; // result.json до карты
  const schools = [...new Map(zones.flatMap((z) => z.schools).map((s): [string, School] => [s.bsn, s])).values()];
  const pts = [...withPoints.flatMap((z) => z.points!), ...schools.map((s): [number, number] => [s.lon, s.lat])];
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const [lon0, lon1, lat0, lat1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const kx = Math.cos(((lat0 + lat1) / 2) * (Math.PI / 180)); // градус долготы короче градуса широты
  const pad = 0.08;
  const spanX = Math.max((lon1 - lon0) * kx, 0.002) * (1 + 2 * pad);
  const spanY = Math.max(lat1 - lat0, 0.002) * (1 + 2 * pad);
  // масштаб — по более тесной стороне: вытянутая с севера на юг улица не уходит за край карты
  const scale = Math.min(MAP_W / spanX, (MAP_W * 1.2) / spanY);
  const h = Math.round(spanY * scale);
  const cx = (lon0 + lon1) / 2;
  const cy = (lat0 + lat1) / 2;
  const bbox = [cx - MAP_W / 2 / (kx * scale), cy - h / 2 / scale, cx + MAP_W / 2 / (kx * scale), cy + h / 2 / scale];
  return { withPoints, schools, h, bbox, x: (lon: number) => (MAP_W / 2 + (lon - cx) * kx * scale).toFixed(1), y: (lat: number) => (h / 2 - (lat - cy) * scale).toFixed(1) };
}

/**
 * Карта зон запроса: границы зон, дома запроса точками, школы маркерами. Зон бывает до десятка — цветом их
 * не различить (на карте надёжно различимы только 3 оттенка), поэтому зона подписана номером прямо на карте,
 * заливка нейтральная. Подсказка при наведении — <title>. Табличный вид — таблица зон выше.
 * basemap — data: URI подложки basemap.de на кадр mapFrame (улицы и названия); нет — карта без подложки.
 */
export function zoneMap(zones: ZoneShare[], basemap: string | null = null): string {
  const frame = mapFrame(zones);
  if (!frame) return '';
  const { withPoints, schools, h, x, y } = frame;
  const ring = (r: number[][]) => `M${r.map(([lon, lat]) => `${x(lon)},${y(lat)}`).join('L')}Z`;
  const path = (g: NonNullable<ZoneShare['geometry']>) =>
    (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []).flat().map(ring).join('');
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const areas = withPoints
    .map(
      (z) => `<path class="zone" d="${path(z.geometry!)}"><title>Зона ${esc(z.esb)} · ${z.schools.map((s) => `${esc(s.name)} ${esc(s.bsn)}`).join(' / ')} · адресов: ${z.addresses}</title></path>`,
    )
    .join('');
  const dots = withPoints.flatMap((z) => z.points!.map(([lon, lat]) => `<circle cx="${x(lon)}" cy="${y(lat)}" r="2"/>`)).join('');
  const marks = schools
    .map(
      (s) => `<g class="school"><circle cx="${x(s.lon)}" cy="${y(s.lat)}" r="6"/><text x="${(+x(s.lon) + 9).toFixed(1)}" y="${(+y(s.lat) + 4).toFixed(1)}">${esc(s.bsn)}</text><title>${esc(s.name)} ${esc(s.bsn)}</title></g>`,
    )
    .join('');
  // подпись зоны — в центре её домов запроса, а не всей зоны: зона может уходить далеко за район;
  // рядом с маркером школы (школа часто в центре своей зоны) — сдвигаем ниже, чтобы не закрывать номер школы
  const nearSchool = (px: number, py: number) => schools.some((s) => Math.abs(+x(s.lon) - px) < 70 && Math.abs(+y(s.lat) - py) < 24);
  const labels = withPoints
    .map((z) => {
      const px = +x(mean(z.points!.map((p) => p[0])));
      let py = +y(mean(z.points!.map((p) => p[1])));
      if (nearSchool(px, py)) py += 30;
      return `<text class="label" x="${px.toFixed(1)}" y="${py.toFixed(1)}">${esc(z.esb)}</text>`;
    })
    .join('');
  // свёрнута: таблица зон выше — основной вид, карта длинная и нужна не каждому
  return `<details class="zone-map-box"><summary>🗺 Карта зон (${withPoints.length})</summary>
  <figure class="zone-map${basemap ? ' with-basemap' : ''}">
    <div class="scroll"><svg viewBox="0 0 ${MAP_W} ${h}" role="img" aria-label="Карта зон Einschulbereich: границы зон, дома запроса и школы">
      ${basemap ? `<image class="basemap" href="${basemap}" width="${MAP_W}" height="${h}" preserveAspectRatio="none"/>` : ''}<g class="zones">${areas}</g><g class="dots">${dots}</g><g>${labels}</g>${marks}
    </svg></div>
    <figcaption>Границы зон Einschulbereich (номер зоны — на карте), точки — дома запроса, кружки с номером — школы. Наведите на зону или школу — подсказка; на телефоне карта листается вбок.${basemap ? ` Подложка: © GeoBasis-DE / BKG (${new Date().getFullYear()}), <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.` : ''}</figcaption>
  </figure>
  </details>`;
}

/** «ℹ️ Ещё 100 адресов PLZ 14197 — в других районах (Schmargendorf), в отчёт не вошли: зоны 0716 Ruppin-Grundschule (40), …». */
const excludedNote = (r: Pick<PlzResult, 'input' | 'excludedByOrtsteil'>) => {
  const x = r.excludedByOrtsteil;
  if (!x) return '';
  const zones = x.zones.map((z) => `${esc(z.esb)}${z.school ? ` ${esc(z.school)}` : ''} (${z.addresses})`).join(', ');
  // с улицей — дома этой улицы, а не всего PLZ
  const what = r.input.street ? `${esc(r.input.street)} в PLZ ${esc(r.input.plz)}` : `PLZ ${esc(r.input.plz)}`;
  return `<p class="meta">ℹ️ Ещё ${x.addresses} адресов ${what} — в других районах (${esc(x.ortsteile.join(', '))}), в отчёт не вошли${zones ? `: зоны ${zones}` : ''}.</p>`;
};

/** ctx — проверенный context.json по школам PLZ, если его собирали; basemap — подложка карты (zoneMap). */
export function renderPlzReport(r: PlzResult, ctx: PlzContext | null = null, basemap: string | null = null): string {
  const facts = new Map(ctx?.schools.map((c) => [c.bsn, c]));
  const data = new Map(r.schools.map((s) => [s.school.bsn, s.data]));
  const years = (r.schools[0]?.data.pages.vunt ?? []).map((y) => y.year);
  const outside = r.addresses - r.zones.reduce((n, z) => n + z.addresses, 0);
  // имя из WFS: в Schulporträt к названию приписан номер школы, а он в отчёте и так стоит рядом
  const schoolName = (s: School) => s.name;
  const marker = (s: School) => {
    const d = data.get(s.bsn);
    return d ? esc(verdict(scoreSchool(d)).text) : '<span class="nd">Schulporträt не загрузился</span>';
  };
  // имя школы в таблицах — ссылка на её блок в «Школах»; Schulporträt не загрузился — блока нет, ссылки тоже
  const toSchool = (s: School) => (data.has(s.bsn) ? `<a href="#school-${esc(s.bsn)}">${esc(schoolName(s))}</a>` : esc(schoolName(s)));

  // запрос по району охватывает несколько PLZ — тогда таблица «PLZ из объявления → школы»
  const manyPlz = new Set(r.zones.flatMap((z) => (z.plzs ?? []).map((p) => p.plz))).size > 1; // plzs нет в result.json до района
  // у доли подписан знаменатель: в таблице зон — все дома запроса, в таблице PLZ — дома одного PLZ
  const scope = r.input.street ? 'улицы' : r.input.ortsteil ? 'района' : 'PLZ';

  // две колонки без .summary: текст переносится, и маркер виден на телефоне без прокрутки
  const zonesTable = `<div class="scroll"><table>
    <thead><tr><th>Доля домов ${scope}</th><th>Школа и маркер</th></tr></thead>
    <tbody>${r.zones
      .map((z) => {
        const st = STATUS_TEXT[z.status];
        return z.schools
          .map(
            (s, i) => `<tr>
              ${i === 0 ? `<th scope="row" rowspan="${z.schools.length}"><b>${esc(share(z.addresses, r.addresses))}</b> <small>(${z.addresses})</small><br><small>зона ${esc(z.esb)}</small>${st.warn ? `<br><small class="bad">⚠️ ${esc(st.text)}</small>` : ''}${(z.withoutZone ?? []).map((w) => `<br><small>ℹ️ ещё в зоне ${esc(schoolName(w))} ${esc(w.bsn)} — своей зоны нет, не закреплена</small>`).join('')}</th>` : ''}
              <td>${z.status === 'matched_by_code' ? `<small>${i === 0 ? 'вероятно закреплённая' : 'кандидат'}</small><br>` : z.status === 'code_mismatch' ? `<small>${i === 0 ? 'стоит в зоне, номер другой' : 'номер совпадает с кодом зоны'}</small><br>` : z.status === 'joint' ? '<small>общая зона</small><br>' : ''}${toSchool(s)} <small>${esc(s.bsn)}${inStartchancen(s) ? ' · 🔶 Startchancen' : ''}</small><br>${marker(s)}</td>
            </tr>`,
          )
          .join('');
      })
      .join('')}</tbody>
  </table></div>`;

  // объявление называет PLZ: по каждому PLZ района — какие зоны и школы в нём, от большей доли к меньшей, с маркером:
  // весь ответ на «какая школа при этом PLZ и какая она» в одной строке
  const byPlz = new Map<string, { z: ZoneShare; n: number }[]>();
  for (const z of r.zones) for (const p of z.plzs ?? []) (byPlz.get(p.plz) ?? byPlz.set(p.plz, []).get(p.plz)!).push({ z, n: p.addresses });
  const plzTable = manyPlz
    ? `<section>
  <h2>PLZ из объявления → школы</h2>
  <div class="scroll"><table>
    <thead><tr><th>PLZ</th><th>Доля домов PLZ — школа и маркер</th></tr></thead>
    <tbody>${[...byPlz]
      .map(([plz, zs]) => [plz, zs, zs.reduce((n, x) => n + x.n, 0)] as const)
      .sort((a, b) => b[2] - a[2])
      .map(
        ([plz, zs, total]) => `<tr><th scope="row">${esc(plz)}<br><small>домов в ${scope === 'улицы' ? 'запросе' : 'районе'}: ${total}</small></th><td><ul class="plz-zones">${zs
          .sort((a, b) => b.n - a.n)
          .map(
            ({ z, n }) =>
              `<li><b>${esc(share(n, total))}</b> <small>(${n}) · зона ${esc(z.esb)}${z.status === 'joint' ? ', общая' : ''}</small>${z.schools.map((s) => `<br>${toSchool(s)} <small>${esc(s.bsn)}</small> — ${marker(s)}`).join('')}</li>`,
          )
          .join('')}</ul></td></tr>`,
      )
      .join('')}</tbody>
  </table></div>
  <p class="note">Только дома этого района: часть PLZ может лежать в соседнем районе.</p>
</section>`
    : '';

  const schoolSections = r.schools
    .map(
      ({ school: s, data: d }) => `<section class="metric" id="school-${esc(s.bsn)}">
        <h3>${esc(schoolName(s))} · ${esc(s.bsn)}</h3>
        <div>${[link(d.portraitUrl, 'Schulporträt'), link(maps.place(s), 'Google Maps')].join(' · ')}</div>
        ${startchancenNote(s)}
        ${scoreBlock(d, (d.pages.vunt ?? []).map((y) => y.year))}
        ${plzFacts(facts.get(s.bsn))}
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
        ${z.streets.map((s) => `<p><b>${esc(s.street)}</b>: ${s.houses.length ? esc(s.houses.join(', ')) : 'без номера дома'}</p>`).join('')}
      </details>`,
    )
    .join('');

  const where = r.input.street
    ? `Адреса улицы в ${r.input.ortsteil ? 'этом районе' : 'этом PLZ'}`
    : r.input.ortsteil
      ? 'Адреса района'
      : 'Адреса PLZ';
  return page(`Школы — ${plzTitle(r.input)}`, `<main>
<header style="display:grid;gap:6px">
  <span class="eyebrow">Поиск по ${r.input.ortsteil ? 'району' : 'PLZ'} · слой ${esc(r.esbLayer)} · отчёт от ${esc(r.generatedAt.slice(0, 10))}</span>
  <h1>Школы — ${esc(plzTitle(r.input))}</h1>
  <div class="meta">${where} в реестре: <b>${r.addresses}</b> · зон Einschulbereich: <b>${r.zones.length}</b></div>
  ${officesBlock([...new Set(r.schools.map((s) => s.school.bezirk))])}
</header>

${
  r.zones.length > 1
    ? `<p class="warn">⚠️ ${where} делятся между ${r.zones.length} зонами — закреплённая школа зависит от номера дома. Узнайте точный адрес у арендодателя и проверьте его через /school.</p>`
    : `<p class="meta">Все адреса — в одной зоне.</p>`
}
${outside ? `<p class="warn">⚠️ Адресов вне всех зон: ${outside}.</p>` : ''}
${excludedNote(r)}

${plzTable}

<section>
  <h2>Зоны и школы</h2>
  ${zonesTable}
  ${zoneMap(r.zones, basemap)}
  <p class="note">Доля — от числа адресов (домов) в реестре, не квартир: особняк и дом на 200 квартир считаются одинаково. Это не вероятность, что квартира попадёт в зону. Маркер — за ${years.length} уч. года, как в отчёте по адресу.</p>
</section>

${zuzugBlock()}

<section>
  <h2>Школы</h2>
  ${schoolSections}
  ${ctx?.schools[0] ? checkedNote(ctx.schools[0]) : ''}
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
