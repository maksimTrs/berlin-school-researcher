import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { findQuote, normalize, pageText, type Fetched } from './context.js';

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
        quote: z.string().min(30).max(600), // дословно из документа, пропуски — «…»
        summaryRu: z.string().min(10).max(160),
      }),
    )
    .min(1),
  links: z.array(z.object({ url: z.string().url(), label: z.string() })),
});
export type Zuzug = z.infer<typeof Snapshot>;

let snapshot: Zuzug | undefined;
export const zuzug = () => (snapshot ??= Snapshot.parse(JSON.parse(readFileSync(FILE, 'utf8'))));

/** Каждая цитата снимка ещё есть в своём документе дословно; ссылки открываются. Пустой список — всё на месте. */
export async function verifyZuzug(snap: Zuzug, fetchUrl: (url: string) => Promise<Fetched>): Promise<string[]> {
  const texts = new Map<string, Promise<string>>();
  const load = (url: string) => {
    if (!texts.has(url))
      texts.set(
        url,
        fetchUrl(url).then(async (f) => {
          if (f.status >= 400) throw new Error(`HTTP ${f.status}`);
          return normalize(await pageText(f));
        }),
      );
    return texts.get(url)!;
  };
  const problems: string[] = [];
  for (const i of snap.items) {
    const text = await load(i.url).catch(() => null); // ошибку загрузки называем один раз — ниже, по URL
    if (text !== null && !findQuote(text, i.quote)) problems.push(`${i.url}: цитаты «${i.quote.slice(0, 60)}…» больше нет в документе`);
  }
  for (const url of new Set([...snap.items.map((i) => i.url), ...snap.links.map((l) => l.url)])) {
    await load(url).catch((e) => problems.push(`${url}: ${(e as Error).message}`));
  }
  return problems;
}
