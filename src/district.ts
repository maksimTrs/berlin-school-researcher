import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { currentEsbLayer } from './config.js';
import {
  CATEGORIES,
  contextWindow,
  findQuote,
  foreignNumbers,
  isDocumentDate,
  mentionsSchool,
  normalize,
  pageText,
  schoolKeys,
  sourceKind,
  type Category,
  type ContextItem,
  type Fetched,
  type Rejected,
} from './context.js';
import type { School } from './geo.js';

/**
 * Документы округа, которые веб-поиск находит через раз: инвестплан (таблица строк по школам) и решение о зонах.
 * Код сам скачивает каждый документ и берёт строки по BSN — факты одинаковы при каждом прогоне.
 * Дата — `published`: дата решения Bezirksamt со страницы `decision` (в самих PDF её нет). `canary` сверяет снимок с сайтом.
 */
const FILE = new URL('../config/district.json', import.meta.url);

const BSN = z.string().regex(/^\d{2}[A-Z]\d{2}$/);
const Day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
// bezirk — как в WFS (`bezirk` школы): документ скачивается только для школ своего округа. Не префикс BSN: у одной школы Pankow он «02»
const Common = { bezirk: z.string().min(3), url: z.string().url(), title: z.string().min(5), published: Day, decision: z.string().url() };
// инвестплан Bezirksamt подаёт каждую весну (на следующие 5 лет): заявка старше этого — canary просит проверить, нет ли новой
export const PLAN_MAX_AGE_MONTHS = 15;

const Snapshot = z.object({
  documents: z.array(
    z.discriminatedUnion('kind', [
      // инвестплан: строка — до года окончания стройки (EndeBau)
      // checked — дата, когда на сайте Bezirksamt проверили, что новее этой заявки нет (срок PLAN_MAX_AGE_MONTHS считается от неё)
      z.object({ kind: z.literal('investment'), ...Common, checked: Day.optional() }).strict(),
      // решение о зонах: действует, пока идёт слой зон, под который принято; цитаты — дословно из документа
      z
        .object({
          kind: z.literal('catchment'),
          ...Common,
          layer: z.string().regex(/^esb_\d{4}$/),
          items: z
            .array(
              z
                .object({
                  bsn: z.array(BSN).min(1),
                  category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]),
                  quote: z.string().min(30).max(600),
                  summaryRu: z.string().min(10).max(160), // пересказывает только цитату
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
    ]),
  ),
});
export type District = z.infer<typeof Snapshot>;

let snapshot: District | undefined;
export const parseDistrict = (json: unknown): District => Snapshot.parse(json);
export const district = () => (snapshot ??= parseDistrict(JSON.parse(readFileSync(FILE, 'utf8'))));

// ---------- инвестплан ----------

export type InvestmentRow = {
  bsn: string;
  zuweisung: 'Gezielte' | 'Pauschale';
  measure: string; // «Gesamtsanierung», «Erweiterungsbau» — как в плане
  status: 'Begonnen' | 'Verschoben' | 'Wegfall' | null;
  endeBau: number; // столбец «EndeBau» — год окончания стройки
  priority: number | null; // «Schule N» — место в Dringlichkeitsliste ещё не начатых строек
  quote: string; // дословно из документа: от BSN до EndeBau (или до приоритета)
};

// «3701 70206 Gezielte Zuweisung Inv. 04G12, …» — начало строки таблицы: Kapitel, Titel, вид финансирования
const ROW_START = /^\d{4} \d{5} (Gezielte|Pauschale) Zuweisung Inv\. /;
// «04G18, Name: Gesamtsanierung; 10715, Babelsberger Str. 24-25 1.365 Verschoben 2027»: адрес — до суммы в T€ (с точкой тысяч), затем статус и EndeBau
const ROW =
  /^(\d{2}[A-Z]\d{2})[,;] ?[^:;,]+?[:;,] (.+?)[;,]? \d{5},? (?:(?! \d{1,3}\.\d{3}(?: |$)).)+? \d{1,3}(?:\.\d{3})* (?:(Begonnen|Verschoben|Wegfall) )?(20\d{2})(?= |$)/u;
const PRIORITY_AT_END = / Schule (\d{1,2})\s*$/;

/**
 * Строки таблицы инвестплана, у которых есть BSN и EndeBau. Строка, перенесённая в PDF на вторую строку текста
 * («…für Schule und Kita;» / «10711 Joachim-…»), склеивается со следующей. Без EndeBau — без срока, пропускаем.
 */
export function parseInvestment(text: string): InvestmentRow[] {
  const lines = text.split('\n');
  const rows: InvestmentRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = ROW_START.exec(lines[i]);
    if (!start) continue;
    const own = lines[i].slice(start[0].length);
    const next = lines[i + 1] !== undefined && !ROW_START.test(lines[i + 1]) ? `${own}\n${lines[i + 1]}` : null;
    for (const raw of next === null ? [own] : [own, next]) {
      const m = ROW.exec(raw.replace(/\n/g, ' ')); // замена 1:1 — позиции совпадают с raw
      if (!m) continue;
      const priority = PRIORITY_AT_END.exec(raw);
      const quote = (priority && raw.length <= 600 ? raw : raw.slice(0, m[0].length)).trimEnd();
      rows.push({
        bsn: m[1],
        zuweisung: start[1] as InvestmentRow['zuweisung'],
        measure: m[2].trim(),
        status: (m[3] as InvestmentRow['status']) ?? null,
        endeBau: Number(m[4]),
        priority: priority && raw.length <= 600 ? Number(priority[1]) : null,
        quote,
      });
      break;
    }
  }
  return rows;
}

// пристройка или надстройка — это места (тема capacity); санация, спортзал, столовая — плановая стройка (construction)
const PLACES = /erweiterungsbau|ergänzungsbau|schulplatzerweiterung|aufstockung anbau/i;
export const investmentCategory = (r: Pick<InvestmentRow, 'measure'>): Category => (PLACES.test(r.measure) ? 'capacity' : 'construction');

const STATUS: Record<'Begonnen' | 'Verschoben', string> = { Begonnen: 'начата (Begonnen)', Verschoben: 'перенесена (Verschoben)' };

/** Однострочник по строке плана: только поля строки, числа — из цитаты. */
export function investmentSummary(r: InvestmentRow): string {
  const head = 'Заявка округа в инвестпрограмму — ';
  const tail = `${r.status && r.status !== 'Wegfall' ? `, ${STATUS[r.status]}` : ''}, окончание стройки по плану — ${r.endeBau}`;
  const prio = r.priority ? `; приоритет ${r.priority} в Dringlichkeitsliste округа` : '';
  // однострочник — не длиннее 160 знаков: длинное название работ укорачиваем
  const room = 160 - head.length - tail.length - prio.length;
  return `${head}${r.measure.length > room ? `${r.measure.slice(0, room - 1)}…` : r.measure}${tail}${prio}`;
}

/** Строка ещё впереди: не отменена (Wegfall), год окончания не прошёл и не дальше окна стройки (constructionFutureMonths). */
export function investmentInWindow(r: Pick<InvestmentRow, 'status' | 'endeBau'>, now: Date): boolean {
  const w = contextWindow(now);
  const year = Math.floor(w.now / 12);
  return r.status !== 'Wegfall' && r.endeBau >= year && r.endeBau <= Number(w.constructionTo.slice(0, 4));
}

// ---------- факты школы ----------

type Text = { final: string; text: string; raw: string };

/** Скачать документ: только официальный источник (и после переадресаций), PDF или HTML. */
const loadDoc = async (fetchUrl: (url: string) => Promise<Fetched>, url: string): Promise<Text> => {
  const f = await fetchUrl(url);
  if (f.status >= 400) throw new Error(`HTTP ${f.status}`);
  if (sourceKind(url) !== 'official' || sourceKind(f.url) !== 'official') throw new Error(`${new URL(f.url).hostname}: не официальный источник (config.context.officialSources)`);
  const raw = await pageText(f);
  return { final: f.url, text: normalize(raw), raw };
};

// urls — документы, которые код покрыл для этой школы: такая же запись в черновике Claude — повтор
export type DistrictFacts = { items: ContextItem[]; rejected: Rejected[]; urls: string[] };

/**
 * Факты из документов округа для одной школы. Документ скачивается один раз на прогон (в PLZ — на все школы).
 * Не загрузился или цитаты снимка нет в документе — строка в rejected, остальные документы идут дальше.
 */
export function districtFacts(fetchUrl: (url: string) => Promise<Fetched>, snap: District = district()) {
  const docs = new Map<string, Promise<Text>>();
  const load = (url: string) => {
    if (!docs.has(url)) docs.set(url, loadDoc(fetchUrl, url));
    return docs.get(url)!;
  };
  return async (school: Pick<School, 'bsn' | 'name' | 'bezirk'>, now = new Date()): Promise<DistrictFacts> => {
    const out: DistrictFacts = { items: [], rejected: [], urls: [] };
    for (const doc of snap.documents.filter((d) => d.bezirk === school.bezirk)) {
      const mine = doc.kind === 'catchment' ? doc.items.filter((i) => i.bsn.includes(school.bsn)) : null;
      // цитат этой школы в снимке решения о зонах нет — документ не скачиваем, и факт о ней из черновика Claude проверяется как обычно
      if (mine && !mine.length) continue;
      out.urls.push(doc.url);
      let t: Text;
      try {
        t = await load(doc.url);
      } catch (e) {
        out.rejected.push({ url: doc.url, summaryRu: doc.title, reason: `документ округа не загрузился: ${(e as Error).message.split('\n')[0]}` });
        continue;
      }
      const item = (category: Category, quote: string, summaryRu: string, planned: string | null): ContextItem => ({
        category,
        published: doc.published,
        planned,
        url: doc.url,
        quote,
        summaryRu,
        contradicts: null,
        host: new URL(t.final).hostname,
        source: 'official',
        rule: 'district',
      });
      if (doc.kind === 'investment') {
        for (const r of parseInvestment(t.raw).filter((r) => r.bsn === school.bsn)) {
          if (investmentInWindow(r, now)) out.items.push(item(investmentCategory(r), r.quote, investmentSummary(r), String(r.endeBau)));
        }
        continue;
      }
      if (currentEsbLayer(now) !== doc.layer) continue; // слой зон сменился — решение о прежних зонах уже не про текущий год
      const keys = schoolKeys(school);
      for (const i of mine!) {
        const at = findQuote(t.text, i.quote);
        if (!at || !mentionsSchool(t.text, at, keys)) {
          out.rejected.push({ url: doc.url, summaryRu: i.summaryRu, reason: 'цитаты снимка config/district.json нет в документе — сверь снимок' });
          continue;
        }
        out.items.push(item(i.category, i.quote, i.summaryRu, null));
      }
    }
    return out;
  };
}

// ---------- canary ----------

/**
 * Снимок устарел по календарю — без сети (canary и проверка на старте сессии): отчёты иначе молча теряют строки —
 * решение о прошлом слое зон не показывается, план прошлого года неполон.
 */
export function districtStale(snap: District, now = new Date()): string[] {
  const month = contextWindow(now).now;
  const monthOfDay = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
  return snap.documents.flatMap((doc) =>
    doc.kind === 'catchment' && doc.layer < currentEsbLayer(now)
      ? [`${doc.url}: решение о зонах для ${doc.layer}, а текущий слой — ${currentEsbLayer(now)}; в отчёты оно больше не идёт — найди решение Bezirksamt о Zuschneidung der Einschulungsbereiche под новый слой или удали запись`]
      : doc.kind === 'investment' && month - monthOfDay(doc.checked ?? doc.published) > PLAN_MAX_AGE_MONTHS
        ? [`${doc.url}: заявке в инвестпрограмму от ${doc.published} больше ${PLAN_MAX_AGE_MONTHS} мес. — найди на сайте Bezirksamt новую (Anmeldungen zum Investitionsprogramm) и замени запись; новее нет — поставь checked: дату проверки`]
        : [],
  );
}

/**
 * Снимок ещё совпадает с сайтом: не устарел по календарю, документ открывается, в инвестплане разбираются строки, цитаты решения о зонах на месте,
 * пересказ без чужих чисел, страница решения Bezirksamt называет эту дату и ссылается на документ.
 */
export async function verifyDistrict(snap: District, fetchUrl: (url: string) => Promise<Fetched>, now = new Date()): Promise<string[]> {
  const problems = districtStale(snap, now);
  for (const doc of snap.documents) {
    try {
      const t = await loadDoc(fetchUrl, doc.url);
      if (doc.kind === 'investment') {
        const rows = parseInvestment(t.raw);
        if (!rows.length) problems.push(`${doc.url}: ни одной строки школы с EndeBau — сменилась вёрстка таблицы?`);
        const lost = rows.filter((r) => !findQuote(t.text, r.quote));
        if (lost.length) problems.push(`${doc.url}: цитаты строк ${lost.map((r) => r.bsn).join(', ')} не находятся в тексте`);
      } else {
        for (const i of doc.items) {
          const foreign = foreignNumbers(i.summaryRu, i.quote);
          if (foreign.length) problems.push(`${doc.url}: в пересказе числа, которых нет в цитате: ${foreign.join(', ')}`);
          if (!findQuote(t.text, i.quote)) problems.push(`${doc.url}: цитаты «${i.quote.slice(0, 60)}…» больше нет в документе`);
        }
      }
    } catch (e) {
      problems.push(`${doc.url}: ${(e as Error).message.split('\n')[0]}`);
    }
    try {
      const f = await fetchUrl(doc.decision);
      if (f.status >= 400) throw new Error(`HTTP ${f.status}`);
      if (sourceKind(f.url) !== 'official') throw new Error(`${new URL(f.url).hostname}: не официальный источник`);
      if (!isDocumentDate(normalize(await pageText(f)).slice(0, 1500), doc.published)) problems.push(`${doc.decision}: первая дата на странице решения — не ${doc.published}`);
      const file = new URL(doc.url).pathname.split('/').pop()!;
      if (!f.body.toString('utf8').includes(file)) problems.push(`${doc.decision}: страница решения больше не ссылается на ${file}`);
    } catch (e) {
      problems.push(`${doc.decision}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return problems;
}
