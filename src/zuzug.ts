import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { findQuote, isDocumentDate, normalize, pageText, sourceKind, type Fetched } from './context.js';

/**
 * Переезд в Берлин посреди учебного года: как распределяют в школу. Правила общие для Берлина и меняются редко —
 * поэтому в отчёт идёт снимок цитат из документов SenBJF (config/zuzug.json), а `canary` сверяет каждую цитату с документом.
 */
const FILE = new URL('../config/zuzug.json', import.meta.url);

const Snapshot = z.object({
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z
    .array(
      z.object({
        url: z.string().url(),
        // дата документа — первая дата в его шапке, как в context.ts; null — на странице даты нет (сверяется только цитата)
        published: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/).nullable(),
        quote: z.string().min(30).max(600), // дословно из документа, пропуски — «…»
        summaryRu: z.string().min(10).max(160), // пересказывает только цитату
      }),
    )
    .min(1),
  links: z.array(z.object({ url: z.string().url(), label: z.string() })),
});
export type Zuzug = z.infer<typeof Snapshot>;

let snapshot: Zuzug | undefined;
export const zuzug = () => (snapshot ??= Snapshot.parse(JSON.parse(readFileSync(FILE, 'utf8'))));

const HEADER = 1500; // как в context.ts: дата документа — в его шапке

/**
 * Каждый источник — официальный (config.context.officialSources, и после переадресаций тоже), цитата ещё есть
 * в документе дословно, первая дата в шапке — published; ссылки открываются. Пустой список — всё на месте.
 */
export async function verifyZuzug(snap: Zuzug, fetchUrl: (url: string) => Promise<Fetched>): Promise<string[]> {
  const texts = new Map<string, Promise<string>>();
  const load = (url: string) => {
    if (!texts.has(url))
      texts.set(
        url,
        fetchUrl(url).then(async (f) => {
          if (sourceKind(url) !== 'official' || sourceKind(f.url) !== 'official') throw new Error(`${new URL(f.url).hostname}: не официальный источник (config.context.officialSources)`);
          if (f.status >= 400) throw new Error(`HTTP ${f.status}`);
          return normalize(await pageText(f));
        }),
      );
    return texts.get(url)!;
  };
  const problems: string[] = [];
  for (const i of snap.items) {
    const text = await load(i.url).catch(() => null); // ошибку загрузки называем один раз — ниже, по URL
    if (text === null) continue;
    if (!findQuote(text, i.quote)) problems.push(`${i.url}: цитаты «${i.quote.slice(0, 60)}…» больше нет в документе`);
    if (i.published && !isDocumentDate(text.slice(0, HEADER), i.published)) problems.push(`${i.url}: первая дата в шапке документа — не ${i.published} (вышла новая редакция?)`);
  }
  for (const url of new Set([...snap.items.map((i) => i.url), ...snap.links.map((l) => l.url)])) {
    await load(url).catch((e) => problems.push(`${url}: ${(e as Error).message}`));
  }
  return problems;
}
