import { parse } from 'node-html-parser';
import { z } from 'zod';
import { config } from './config.js';
import type { Profile } from './extract.js';
import type { School } from './geo.js';

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

const DraftItem = z
  .object({
    category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]),
    published: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/), // дата документа
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

export type ContextItem = DraftItem & { host: string; source: 'official' | 'mirror' };
export type Rejected = { url: string; summaryRu: string; reason: string };
export type Context = {
  bsn: string;
  checkedAt: string;
  window: { publishedFrom: string; plannedTo: string };
  queries: string[];
  items: ContextItem[]; // от новых к старым
  rejected: Rejected[];
};

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

export async function pageText(f: Pick<Fetched, 'contentType' | 'body'>): Promise<string> {
  if (f.contentType.includes('pdf') || f.body.subarray(0, 5).toString('latin1') === '%PDF-') return pdfText(f.body);
  const root = parse(f.body.toString('utf8'));
  root.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
  return (root.querySelector('body') ?? root).structuredText;
}

async function pdfText(body: Buffer): Promise<string> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: new Uint8Array(body), verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
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
    if (i < 0 || (start >= 0 && i - end > 2000)) return null;
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
  return [s.bsn.toLowerCase(), core.replace(/^(am|an der|im|in der) /, '').length >= 6 ? core : full];
}

/** Школа названа рядом с цитатой — в документе обо всех школах округа цитата может быть про другую. */
export function mentionsSchool(text: string, at: { start: number; end: number }, keys: string[]): boolean {
  const around = text.slice(Math.max(0, at.start - 1500), at.end + 1500);
  return keys.some((k) => around.includes(k));
}

const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

/** Дата публикации стоит в самом документе: «29.06.2026», «18. Februar 2026», для месяца — и «Februar 2026». */
export function hasDate(text: string, published: string): boolean {
  const [y, m, d] = published.split('-').map(Number);
  const month = `(${MONTHS[m - 1]}${m === 3 ? '|maerz' : ''})`;
  const day = d ? `0?${d}` : '\\d{1,2}';
  return [
    `(^|\\D)${day}\\.\\s?0?${m}\\.\\s?${y}(\\D|$)`,
    `(^|\\D)${day}\\.\\s*${month}\\s+${y}(\\D|$)`,
    d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : `${y}-${String(m).padStart(2, '0')}(\\D|$)`,
    ...(d ? [] : [`${month}\\s+${y}(\\D|$)`]),
  ].some((re) => new RegExp(re).test(text));
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

export function contextWindow(now: Date) {
  const n = now.getUTCFullYear() * 12 + now.getUTCMonth();
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

const onHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

export function sourceKind(url: string): 'official' | 'mirror' | null {
  const host = new URL(url).hostname;
  return onHost(host, config.context.officialHosts) ? 'official' : onHost(host, config.context.mirrorHosts) ? 'mirror' : null;
}

// копия на сайте фракции годится, только если это документ ведомства, а не пересказ
const OFFICIAL_AUTHOR = /bezirksamt|senatsverwaltung|abgeordnetenhaus|bezirksverordnetenversammlung/;

// ---------- весь черновик ----------

export async function verifyDraft(
  draft: Draft,
  school: Pick<School, 'bsn' | 'name'>,
  profile: Profile,
  fetchUrl: (url: string) => Promise<Fetched>,
  now = new Date(),
): Promise<Context> {
  if (draft.bsn !== school.bsn) throw new Error(`context.draft.json для ${draft.bsn}, а закреплённая школа — ${school.bsn}`);
  const keys = schoolKeys(school);
  const texts = new Map<string, Promise<{ final: string; text: string }>>();
  const load = (url: string) => {
    if (!texts.has(url)) {
      texts.set(
        url,
        fetchUrl(url).then(async (f) => {
          if (f.status >= 400) throw new Error(`HTTP ${f.status}`);
          return { final: f.url, text: normalize(await pageText(f)) };
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
      reject(`сайт ${new URL(item.url).hostname} не в списке официальных (config.context)`);
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
    let page: { final: string; text: string };
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
    if (kind === 'mirror' && !OFFICIAL_AUTHOR.test(page.text.slice(0, 2000))) {
      reject('на сайте-зеркале не документ ведомства');
      continue;
    }
    const at = findQuote(page.text, item.quote);
    if (!at) {
      reject('цитаты нет в источнике дословно');
      continue;
    }
    if (!mentionsSchool(page.text, at, keys)) {
      reject('рядом с цитатой школа не названа');
      continue;
    }
    if (!hasDate(page.text, item.published)) {
      reject(`даты ${item.published} нет в источнике`);
      continue;
    }
    if (item.planned && !numbers(item.quote).includes(item.planned.slice(0, 4))) {
      reject(`года плана ${item.planned.slice(0, 4)} нет в цитате`);
      continue;
    }
    ok.push({ ...item, host: new URL(page.final).hostname, source: kind });
  }

  // компактность: новые первыми, не больше maxPerCategory в категории и maxItems всего
  const items: ContextItem[] = [];
  const seen = new Set<string>();
  for (const item of ok.sort((a, b) => b.published.localeCompare(a.published))) {
    const key = `${item.url}|${normalize(item.quote)}`;
    const reject = (reason: string) => rejected.push({ url: item.url, summaryRu: item.summaryRu, reason });
    if (seen.has(key)) reject('повтор');
    else if (items.filter((i) => i.category === item.category).length >= config.context.maxPerCategory)
      reject(`лимит: не больше ${config.context.maxPerCategory} в категории`);
    else if (items.length >= config.context.maxItems) reject(`лимит: не больше ${config.context.maxItems} фактов`);
    else items.push(item);
    seen.add(key);
  }

  const w = contextWindow(now);
  return {
    bsn: school.bsn,
    checkedAt: now.toISOString(),
    window: { publishedFrom: w.publishedFrom, plannedTo: w.plannedTo },
    queries: draft.queries,
    items,
    rejected,
  };
}
