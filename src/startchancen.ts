import { readFileSync, writeFileSync } from 'node:fs';
import type { APIRequestContext } from 'playwright';
import { z } from 'zod';

/**
 * Школы программы Startchancen (много учеников из социально неблагополучных семей → доп. деньги и персонал).
 * Список меняется раз в год, к учебному году, — поэтому в отчёт идёт снимок из репозитория,
 * а `canary` сверяет его с сайтом; обновление — `npm run update:startchancen`.
 */
export const LIST_PAGE = 'https://www.berlin.de/sen/bildung/unterstuetzung/startchancen-programm/schulen/';
const FILE = new URL('../config/startchancen.json', import.meta.url);

const Snapshot = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  schools: z.array(z.string().regex(/^\d{2}[A-Z]\d{2}$/)).min(50), // меньше — почти наверняка сломан разбор, а не сокращена программа
});

// лениво: команда обновления должна работать, даже если снимка нет или он испорчен
let snapshot: z.infer<typeof Snapshot> | undefined;
export const startchancen = () => (snapshot ??= Snapshot.parse(JSON.parse(readFileSync(FILE, 'utf8'))));

/** На странице списка — карта Google My Maps; id берём со страницы, чтобы заметить замену карты. */
export function kmlUrl(pageHtml: string): string | null {
  const mid = pageHtml.match(/google\.com\/maps\/d\/embed\?mid=([\w-]+)/)?.[1];
  return mid ? `https://www.google.com/maps/d/kml?mid=${mid}&forcekml=1` : null;
}

/** Номера школ из KML. Каждая школа в карте дважды — в слоях «по районам» и «по типам школ». */
export const parseKml = (kml: string): string[] =>
  [...new Set([...kml.matchAll(/<Data name="Schulnummer">\s*<value>\s*([^<]*?)\s*<\/value>/g)].map((m) => m[1]))].sort();

export async function fetchStartchancen(api: APIRequestContext): Promise<string[]> {
  const page = await api.get(LIST_PAGE, { timeout: 30_000 });
  if (!page.ok()) throw new Error(`страница списка: HTTP ${page.status()}`);
  const url = kmlUrl(await page.text());
  if (!url) throw new Error('на странице списка нет карты Google My Maps');
  const kml = await api.get(url, { timeout: 30_000 });
  if (!kml.ok()) throw new Error(`KML карты: HTTP ${kml.status()}`);
  const parsed = Snapshot.shape.schools.safeParse(parseKml(await kml.text()));
  if (!parsed.success) throw new Error(`KML не разобран — сменился формат выгрузки Google (${parsed.error.issues[0].message})`);
  return parsed.data;
}

export const diffSchools = (before: string[], after: string[]) => ({
  added: after.filter((s) => !before.includes(s)),
  removed: before.filter((s) => !after.includes(s)),
});

export function saveSnapshot(schools: string[]): void {
  const snapshot = { source: LIST_PAGE, fetchedAt: new Date().toISOString().slice(0, 10), schools };
  writeFileSync(FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
}
