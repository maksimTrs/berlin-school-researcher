import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'node-html-parser';
import type { APIRequestContext } from 'playwright';
import { z } from 'zod';
import { config } from './config.js';
import type { Profile } from './extract.js';
import type { School } from './geo.js';
import { firstLine } from './preflight.js';

/**
 * Факты о школе из официальных источников: Claude находит и пишет черновик (context.draft.json),
 * код скачивает каждый источник и оставляет только то, что в нём дословно есть.
 */

export const CATEGORIES = {
  capacity: 'Места и помещения',
  construction: 'Стройка и ремонт',
  welcome_classes: 'Классы для детей без немецкого',
  catchment: 'Школьная зона',
  leadership: 'Руководство школы',
  afterschool: 'Продлёнка (Hort)',
} as const;
export type Category = keyof typeof CATEGORIES;

/**
 * Что важнее семье, когда фактов больше лимита: есть ли место, чья это зона, стройка, затем Willkommensklassen —
 * для детей с 3 класса это главное, а детей до 7 лет по правилам SenBJF берут в обычный класс (config/zuzug.json);
 * продлёнка и руководство — последними.
 */
export const PRIORITY: Category[] = ['capacity', 'catchment', 'construction', 'welcome_classes', 'afterschool', 'leadership'];

const DraftItem = z
  .object({
    category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]),
    published: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/)
      .refine((d) => d.length === 7 || new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), 'нет такой даты'), // дата документа
    planned: z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/).nullable().default(null), // когда наступит объявленное
    url: z.string().url(),
    quote: z.string().min(30).max(600), // дословно из источника, пропуски — «…»
    summaryRu: z.string().min(10).max(160), // одна строка, числа — только из цитаты
    contradicts: z.string().nullable().default(null), // поле профиля Schulporträt, которое сообщение опровергает
  })
  .strict();
export type DraftItem = z.infer<typeof DraftItem>;

export const Draft = z
  .object({
    bsn: z.string(),
    queries: z.array(z.string()).min(1), // что искали — чтобы пустой результат было с чем сверить
    items: z.array(DraftItem).max(10),
  })
  .strict();
export type Draft = z.infer<typeof Draft>;

/** Черновик по PLZ — по записи на каждую школу зон. */
export const PlzDraft = z
  .object({ schools: z.array(Draft).min(1) })
  .strict()
  .refine((d) => new Set(d.schools.map((s) => s.bsn)).size === d.schools.length, 'школа дважды в черновике');
export type PlzDraft = z.infer<typeof PlzDraft>;

const RejectedSchema = z.object({ url: z.string(), summaryRu: z.string(), reason: z.string() });
// context.json пишет код; схема — чтобы повреждённый файл не ронял lookup и plz после прогона браузера
export const ContextSchema = z.object({
  bsn: z.string(),
  checkedAt: z.string(),
  window: z.object({ publishedFrom: z.string(), plannedTo: z.string() }),
  queries: z.array(z.string()),
  items: z.array(DraftItem.extend({ host: z.string(), source: z.enum(['official', 'mirror']) })), // от новых к старым
  rejected: z.array(RejectedSchema),
});
export const PlzContextSchema = z.object({ schools: z.array(ContextSchema) });
// отчёт по адресу: одна закреплённая школа — Context; общая зона (joint) — по записи на каждую школу зоны, как у PLZ
export const AddressContextSchema = z.union([ContextSchema, PlzContextSchema]);

export type Context = z.infer<typeof ContextSchema>;
export type ContextItem = Context['items'][number];
export type Rejected = z.infer<typeof RejectedSchema>;

export type PlzContext = z.infer<typeof PlzContextSchema>;

export type Fetched = { url: string; status: number; contentType: string; body: Buffer };

// ---------- текст источника ----------

/** Одинаково для страницы и цитаты: переносы слов в PDF, кавычки, тире, пробелы, регистр. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/­/g, '')
    .replace(/(\p{Ll})-[ \t]*\n\s*(\p{Ll})/gu, '$1$2') // «Auswir-\nkungen»
    .replace(/-[ \t]*\n\s*/g, '-') // «Tempelhof-\nSchöneberg»
    .replace(/[„“”«»"]/g, '"')
    .replace(/[‚‘’']/g, "'")
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export const isPdf = (f: Pick<Fetched, 'contentType' | 'body'>) =>
  f.contentType.includes('pdf') || f.body.subarray(0, 5).toString('latin1') === '%PDF-';

/** Текст документа: у HTML — только основное содержимое страницы, без меню и скрытых блоков. */
export async function pageText(f: Pick<Fetched, 'contentType' | 'body'>): Promise<string> {
  if (isPdf(f)) return pdfText(f.body);
  const charset = f.contentType.match(/charset=([\w-]+)/i)?.[1] ?? 'utf-8';
  let html: string;
  try {
    html = new TextDecoder(charset).decode(f.body);
  } catch {
    html = new TextDecoder('utf-8').decode(f.body); // неизвестная кодировка в заголовке
  }
  const root = parse(html);
  root.querySelectorAll('script, style, noscript, template, [hidden], [aria-hidden=true]').forEach((n) => n.remove());
  return (root.querySelector('main, [role=main], article') ?? root.querySelector('body') ?? root).structuredText;
}

const MAX_PDF_PAGES = 60;

async function pdfText(body: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(body), verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES); i++) {
    const { items } = await (await doc.getPage(i)).getTextContent();
    pages.push(items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join(''));
  }
  await task.destroy();
  return pages.join('\n');
}

// ---------- проверки одной записи (text — уже normalize) ----------

/** Позиция цитаты в тексте или null; части через «…» идут по порядку и недалеко друг от друга. */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  const parts = quote.split(/…|\.\.\./).map(normalize).filter(Boolean);
  if (!parts.length || parts.some((p) => p.length < 15)) return null;
  let start = -1;
  let end = 0;
  for (const p of parts) {
    const i = text.indexOf(p, end);
    if (i < 0 || (start >= 0 && i - end > 200)) return null; // «…» пропускает полфразы, а не абзац
    if (start < 0) start = i;
    end = i + p.length;
  }
  return { start, end };
}

/** Как школу называют в документах: номер или имя без «Grundschule»/«Schule» («Bruno-H.-Bürgel-Schule» ↔ «…-Grundschule»). */
export function schoolKeys(s: Pick<School, 'bsn' | 'name'>): string[] {
  const full = normalize(s.name.replace(/\(.*?\)/g, ''));
  const core = full
    .replace(/[-\s]*\b(grundschule|gemeinschaftsschule|schule)(?=$|[\s-])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // одно слово («schöneberger», «am schloss» без места) слишком общее — тогда только полное имя
  const distinct = core.replace(/^(am|an der|im|in der) /, '');
  return [s.bsn.toLowerCase(), distinct.length >= 6 && /[\s-]/.test(core) ? core : full];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// имена школ в тексте: «melli-beese-schule», «nahariya-grundschule», «schule am ginkobaum», номер «07g32»
const ANY_SCHOOL = /(?<![\p{L}\d])(?:[\p{L}\d.]+-)+(?:grund|gemeinschafts|ober|sekundar|gesamt)?schule(?![\p{L}\d])|(?<![\p{L}\d])(?:grund)?schule (?:am|an der|an den|im|in der) [\p{L}-]+|(?<![\p{L}\d])\d{2}[a-z]\d{2}(?![\p{L}\d])/gu;

type Mention = { start: number; end: number; ours: boolean };

const SCHOOL_WORD = '(?:grund|gemeinschafts)?schule';

/**
 * Номер и полное имя — отдельным словом, не школа другого типа. Имя без «Grundschule» — только рядом со словом
 * «schule» («melli-beese-schule», «grundschule am arkonaplatz»): «kurt-tucholsky-straße» и «spielplatz am arkonaplatz» — не школа.
 */
const ownPattern = (k: string) => {
  const key = escapeRe(k);
  if (/^\d{2}[a-z]\d{2}$/.test(k) || new RegExp(`(^|[\\s-])${SCHOOL_WORD}($|[\\s-])`).test(k))
    return `(?<![\\p{L}\\d])${key}(?![\\p{L}\\d])(?![\\s-]*(ober|sekundar|gesamt)schule|[\\s-]*gymnasium)`;
  return `(?<![\\p{L}\\d])${key}[\\s-]*${SCHOOL_WORD}(?![\\p{L}\\d])|(?<=(?<![\\p{L}\\d])${SCHOOL_WORD}[\\s-]+)${key}(?![\\p{L}\\d])`;
};

/** Все упоминания школ: свои — по ключам, остальные — чужие. */
function mentions(text: string, keys: string[]): Mention[] {
  const own: Mention[] = keys.flatMap((k) =>
    [...text.matchAll(new RegExp(ownPattern(k), 'gu'))].map(
      (m) => ({ start: m.index, end: m.index + m[0].length, ours: true }),
    ),
  );
  const others = [...text.matchAll(ANY_SCHOOL)]
    .map((m) => ({ start: m.index, end: m.index + m[0].length, ours: false }))
    .filter((o) => !own.some((m) => m.start < o.end && o.start < m.end)); // «melli-beese-schule» — своя
  return [...own, ...others].sort((a, b) => a.start - b.start);
}

/**
 * Цитата — про эту школу: если в цитате названы школы, среди них есть эта; если нет — ближайшая школа,
 * названная перед цитатой (не дальше 1500 знаков), — эта. В ответе обо всех школах округа соседняя не проходит.
 */
export function mentionsSchool(text: string, at: { start: number; end: number }, keys: string[]): boolean {
  const all = mentions(text, keys);
  const inside = all.filter((m) => m.start >= at.start && m.end <= at.end);
  if (inside.length) return inside.some((m) => m.ours);
  const before = all.filter((m) => m.end <= at.start && at.start - m.end <= 1500).at(-1);
  return before?.ours ?? false;
}

// маркер ответа: «Antwort auf 1. Frage», «Antwort auf die 2. Nachfrage» (BVV), «Zu 1.:», «Zu 1. und 2.:», «Zu 3. bis 5.:» (Abgeordnetenhaus)
const ANSWER = /antwort auf (?:die )?(\d+)\. (?:nach)?frage|(?<![\p{L}\d])zu (?:frage )?(\d+)\.?(?:(?:,| und| bis| -) ?\d+\.?)*:/gu;

/**
 * Цитата из вопроса депутата, а не из ответа ведомства: вопрос — от «N.» до маркера ответа на него
 * («1. Frage … Antwort auf 1. Frage», «1. … ? 2. … ? Zu 1. und 2.:»). Нет маркеров ответа — нет и вопросов.
 */
export function inQuestion(text: string, at: { start: number; end: number }): boolean {
  let prevEnd = 0;
  for (const m of text.matchAll(ANSWER)) {
    // «1. » — начало вопроса, но не «1. Juni» и не «1. 2.»
    const start = new RegExp(`(?<![\\p{L}\\d.])${m[1] ?? m[2]}\\. (?!(${MONTHS.join('|')}|maerz|\\d))`, 'gu');
    const q = [...text.slice(prevEnd, m.index).matchAll(start)].at(-1);
    if (q && prevEnd + q.index < at.end && at.start < m.index) return true;
    prevEnd = m.index + m[0].length;
  }
  return false;
}

const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

const MONTH_NAME = `(?<!\\p{L})(${MONTHS.join('|')}|maerz)(?!\\p{L})`;
const monthNo = (name: string) => (name === 'maerz' ? 3 : MONTHS.indexOf(name) + 1);

// «29.06.2026», «18. Februar 2026», «2026-02-18», «Februar 2026» → [год, месяц, день | null]
const DATE_FORMATS: [RegExp, (m: RegExpExecArray) => [number, number, number | null]][] = [
  [/(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})(?!\d)/u, (m) => [+m[3], +m[2], +m[1]]],
  [new RegExp(`(?<!\\d)(\\d{1,2})\\.\\s*${MONTH_NAME}\\s+(\\d{4})(?!\\d)`, 'u'), (m) => [+m[3], monthNo(m[2]), +m[1]]],
  [/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/u, (m) => [+m[1], +m[2], +m[3]]],
  [new RegExp(`${MONTH_NAME}\\s+(\\d{4})(?!\\d)`, 'u'), (m) => [+m[2], monthNo(m[1]), null]],
];

/**
 * Дата публикации — первая дата в шапке («Pressemitteilung vom 29.06.2026», «… am 18.02.2026»), для месяца сверяется месяц.
 * Дата плана дальше в тексте («Fertigstellung im August 2026») — не дата документа.
 */
export function isDocumentDate(header: string, published: string): boolean {
  const first = DATE_FORMATS.map(([re, parse]) => {
    const m = re.exec(header);
    return m ? { at: m.index, date: parse(m) } : null;
  })
    .filter((f) => f !== null)
    .sort((a, b) => a.at - b.at)[0];
  const [y, m, d] = published.split('-').map(Number);
  return !!first && first.date[0] === y && first.date[1] === m && (!d || first.date[2] === d);
}

const numbers = (s: string) => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', '.'));

/** Числа в однострочнике — только те, что есть в цитате: пересказ не добавляет цифр. */
export function foreignNumbers(summary: string, quote: string): string[] {
  const inQuote = new Set(numbers(quote));
  return numbers(summary).filter((n) => !inQuote.has(n));
}

const monthIndex = (s: string) => {
  const [y, m] = s.split('-').map(Number);
  return y * 12 + (m ? m - 1 : 0);
};
const monthOf = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

/** Месяц по берлинскому времени: в 00:30 1 ноября в Берлине уже ноябрь, а по UTC — ещё октябрь. */
const berlinMonth = (now: Date) => {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' })
    .format(now)
    .split('-')
    .map(Number);
  return y * 12 + m - 1;
};

export function contextWindow(now: Date) {
  const n = berlinMonth(now);
  return { now: n, publishedFrom: monthOf(n - config.context.pastMonths), plannedTo: monthOf(n + config.context.futureMonths) };
}

/** Публикация за последние pastMonths или план, который наступит в ближайшие futureMonths. null — подходит. */
export function outOfWindow(item: Pick<DraftItem, 'published' | 'planned'>, now: Date): string | null {
  const w = contextWindow(now);
  const pub = monthIndex(item.published);
  if (pub > w.now) return 'дата публикации в будущем';
  if (w.now - pub <= config.context.pastMonths) return null;
  if (item.planned && w.now - pub <= config.context.plannedMaxAgeMonths) {
    const from = monthIndex(item.planned);
    const to = item.planned.length === 4 ? from + 11 : from;
    if (to >= w.now && from <= monthIndex(w.plannedTo)) return null;
  }
  return `старше ${config.context.pastMonths} мес. и не план на ближайшие ${config.context.futureMonths} мес.`;
}

/** «berlin.de/ba-» — домен с поддоменами и начало пути: на berlin.de есть и ленты агентств (/aktuelles/berlin/). */
const onSource = (url: URL, list: string[]) =>
  list.some((entry) => {
    const [host, ...path] = entry.split('/');
    const prefix = path.length ? `/${path.join('/')}` : '/';
    return (url.hostname === host || url.hostname.endsWith(`.${host}`)) && url.pathname.startsWith(prefix);
  });

export function sourceKind(url: string): 'official' | 'mirror' | null {
  const u = new URL(url);
  return onSource(u, config.context.officialSources) ? 'official' : onSource(u, config.context.mirrorHosts) ? 'mirror' : null;
}

/** Переадресации — вручную: каждый шаг должен оставаться в списке источников, а не уходить на любой адрес. */
export const fetchFollowing =
  (api: Pick<APIRequestContext, 'get'>) =>
  async (url: string): Promise<Fetched> => {
    let current = url;
    for (let hop = 0, waits = 0; hop <= 5; hop++) {
      const res = await api.get(current, { maxRedirects: 0, maxRetries: 1 });
      // berlin.de отвечает 429 на частые запросы (Retry-After: 2) — ждём и повторяем, не больше 3 раз
      if (res.status() === 429 && waits < 3) {
        waits++;
        hop--;
        await new Promise((r) => setTimeout(r, Math.min(Number(res.headers()['retry-after']) || 2, 10) * 1000));
        continue;
      }
      const location = res.status() >= 300 && res.status() < 400 ? res.headers()['location'] : undefined;
      if (!location) return { url: current, status: res.status(), contentType: res.headers()['content-type'] ?? '', body: await res.body() };
      current = new URL(location, current).toString();
      if (!sourceKind(current)) return { url: current, status: 200, contentType: '', body: Buffer.alloc(0) }; // verifyDraft отклонит
    }
    throw new Error('больше 5 переадресаций');
  };

/** Испорченный context.json не должен стоить отчёта после полного прогона браузера — тогда без блока фактов. */
export function readContext<T>(dir: string, schema: { parse: (v: unknown) => T }): T | null {
  try {
    return existsSync(join(dir, 'context.json')) ? schema.parse(JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8'))) : null;
  } catch (e) {
    const why = e instanceof SyntaxError ? firstLine(e) : 'структура не та, что пишет npm run context';
    console.warn(`${join(dir, 'context.json')}: не читается (${why}) — отчёт без фактов`);
    return null;
  }
}

const MAX_BYTES = 20 * 1024 * 1024;
const HEADER = 1500; // дата публикации — в шапке документа, а не где-то в тексте («…abgeschlossen im Februar 2026»)

// копия на сайте фракции годится, только если это документ ведомства, а не пересказ
const OFFICIAL_AUTHOR = /bezirksamt|senatsverwaltung|abgeordnetenhaus|bezirksverordnetenversammlung/;
const LETTERHEAD = 120;

/**
 * Ответ ведомства: ведомство в бланке, а не фракция, и в шапке — форма ответа.
 * Запрос фракции («Antrag … an die Bezirksverordnetenversammlung: Das Bezirksamt wird ersucht…») и её
 * пресс-релиз («Die Antwort auf unsere Anfrage…») ведомство только называют.
 */
const isAuthorityAnswer = (text: string) => {
  const letterhead = text.slice(0, LETTERHEAD);
  return OFFICIAL_AUTHOR.test(letterhead) && !/fraktion/.test(letterhead) && /antwort auf|beantwortung/.test(text.slice(0, HEADER));
};

// ---------- весь черновик ----------

export async function verifyDraft(
  draft: Draft,
  school: Pick<School, 'bsn' | 'name'>,
  profile: Profile,
  fetchUrl: (url: string) => Promise<Fetched>,
  now = new Date(),
  maxItems = config.context.maxItems,
): Promise<Context> {
  if (draft.bsn !== school.bsn) throw new Error(`context.draft.json для ${draft.bsn}, а закреплённая школа — ${school.bsn}`);
  const keys = schoolKeys(school);
  const texts = new Map<string, Promise<{ final: string; pdf: boolean; text: string }>>();
  const load = (url: string) => {
    if (!texts.has(url)) {
      texts.set(
        url,
        fetchUrl(url).then(async (f) => {
          if (f.status >= 400) throw new Error(`HTTP ${f.status}`);
          if (f.body.length > MAX_BYTES) throw new Error(`больше ${MAX_BYTES / 1024 / 1024} МБ`);
          return { final: f.url, pdf: isPdf(f), text: normalize(await pageText(f)) };
        }),
      );
    }
    return texts.get(url)!;
  };

  const ok: ContextItem[] = [];
  const rejected: Rejected[] = [];
  for (const item of draft.items) {
    const reject = (reason: string) => rejected.push({ url: item.url, summaryRu: item.summaryRu, reason });
    const kind = sourceKind(item.url);
    if (!kind) {
      reject(`${new URL(item.url).hostname}${new URL(item.url).pathname}: не в списке официальных источников (config.context)`);
      continue;
    }
    const late = outOfWindow(item, now);
    if (late) {
      reject(late);
      continue;
    }
    if (item.contradicts && !profile.fields.some(([k]) => k === item.contradicts)) {
      reject(`в профиле нет поля «${item.contradicts}»`);
      continue;
    }
    const foreign = foreignNumbers(item.summaryRu, item.quote);
    if (foreign.length) {
      reject(`в однострочнике числа, которых нет в цитате: ${foreign.join(', ')}`);
      continue;
    }
    let page: { final: string; pdf: boolean; text: string };
    try {
      page = await load(item.url);
    } catch (e) {
      reject(`источник не загрузился: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      continue;
    }
    if (sourceKind(page.final) !== kind) {
      reject(`переадресация на ${new URL(page.final).hostname}`);
      continue;
    }
    // на зеркале — только PDF ведомства: в HTML слово «Bezirksverordnetenversammlung» бывает и в меню
    if (kind === 'mirror' && (!page.pdf || !isAuthorityAnswer(page.text))) {
      reject('на сайте-зеркале не документ ведомства');
      continue;
    }
    const at = findQuote(page.text, item.quote);
    if (!at) {
      reject('цитаты нет в источнике дословно');
      continue;
    }
    if (inQuestion(page.text, at)) {
      reject('цитата из вопроса депутата, а не из ответа ведомства');
      continue;
    }
    if (!mentionsSchool(page.text, at, keys)) {
      reject('рядом с цитатой школа не названа');
      continue;
    }
    if (!isDocumentDate(page.text.slice(0, HEADER), item.published)) {
      reject(`первая дата в шапке документа — не ${item.published}`);
      continue;
    }
    if (item.planned && !numbers(item.quote).includes(item.planned.slice(0, 4))) {
      reject(`года плана ${item.planned.slice(0, 4)} нет в цитате`);
      continue;
    }
    ok.push({ ...item, host: new URL(page.final).hostname, source: kind });
  }

  // компактность: опровержения профиля, затем важные темы (PRIORITY), в теме — новые первыми; не больше maxPerCategory в категории и maxItems всего (у PLZ — на школу)
  const items: ContextItem[] = [];
  const seen = new Set<string>();
  // факт, опровергающий поле профиля, — первым при любой теме: иначе по лимиту пропадёт и ⚠️ у поля
  const rank = (i: ContextItem) => (i.contradicts ? -1 : PRIORITY.indexOf(i.category));
  for (const item of ok.sort((a, b) => rank(a) - rank(b) || b.published.localeCompare(a.published))) {
    const key = `${item.url}|${normalize(item.quote)}`;
    const reject = (reason: string) => rejected.push({ url: item.url, summaryRu: item.summaryRu, reason });
    if (seen.has(key)) reject('повтор');
    else if (items.filter((i) => i.category === item.category).length >= config.context.maxPerCategory)
      reject(`лимит: не больше ${config.context.maxPerCategory} в категории`);
    else if (items.length >= maxItems) reject(`лимит: не больше ${maxItems} фактов`);
    else items.push(item);
    seen.add(key);
  }

  const w = contextWindow(now);
  return {
    bsn: school.bsn,
    checkedAt: now.toISOString(),
    window: { publishedFrom: w.publishedFrom, plannedTo: w.plannedTo },
    queries: draft.queries,
    items: items.sort((a, b) => b.published.localeCompare(a.published)), // в отчёте — от новых к старым
    rejected,
  };
}
