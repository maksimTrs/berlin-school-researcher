import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { findQuote, normalize, pageText, sourceKind, type Fetched } from './context.js';

/**
 * Schulamt (округ: места в школах) и Schulaufsicht (Senat: надзор, жалобы) каждого из 12 округов — снимок
 * со страниц ведомств (config/schulamt.json). Только данные учреждения: адрес, общий ящик и телефон секретариата;
 * имена и личные номера устаревают. Schulaufsicht — ещё и по справочнику SenBJF (`directory`): телефон и ящик оттуда,
 * а адрес справочника сверяется с адресом страницы округа — разные здания в отчёте показаны как расхождение.
 * `canary` сверяет всё это с источниками, а роли — с цитатами SenBJF.
 */
const FILE = new URL('../config/schulamt.json', import.meta.url);

const Office = z.object({
  url: z.string().url(), // страница ведомства на сайте округа; своей нет — общая страница SenBJF
  address: z.string().min(15).nullable(), // дословно со страницы url; null — на странице адреса нет или он не ведомства
  // на странице url адреса нет или он устарел — адрес дословно из этого официального документа (PDF SenBJF и т. п.)
  addressSource: z.string().url().optional(),
  email: z.string().email().nullable(), // общий ящик со страницы url, не личный
});
// запись справочника SenBJF дословно: под заголовком округа — адрес, «Tel.: …», «E-Mail: …»
const Listing = z.object({ address: z.string().min(15), phone: z.string().min(6), email: z.string().email() });
const Role = z.object({ url: z.string().url(), quote: z.string().min(30).max(600), summaryRu: z.string().min(10).max(160) });

const Snapshot = z.object({
  checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  roles: z.object({ schulamt: Role, schulaufsicht: Role }),
  directory: z.object({ url: z.string().url(), title: z.string() }), // справочник Schulaufsicht всех округов от SenBJF
  bezirke: z.record(z.string(), z.object({ schulamt: Office, schulaufsicht: Office.extend({ directory: Listing }) })), // ключ — bezirk, как в WFS
});
export type Schulamt = z.infer<typeof Snapshot>;

let snapshot: Schulamt | undefined;
export const schulamt = () => (snapshot ??= Snapshot.parse(JSON.parse(readFileSync(FILE, 'utf8'))));

// адрес на странице бывает в одну строку с запятой («Alt-Köpenick 21, 12555 Berlin») и в две
const hasAddress = (text: string, address: string) => !!(findQuote(text, address) ?? findQuote(text, address.replace(', ', ' ')));

/**
 * Одно ли это здание: улица, первый номер дома и PLZ. «Str.»/«Straße» и «29»/«29–31» — одно здание,
 * Wilskistraße 84 и Hartmannsweilerweg 65 — разные. Не разобрали адрес — считаем разными: пусть проверит человек.
 */
export function sameAddress(a: string, b: string): boolean {
  const key = (s: string) => {
    const m = s.match(/^(.+?)\s*(\d+)\D.*?(\d{5})/);
    if (!m) return null;
    const street = m[1].toLowerCase().replace(/stra(ß|ss)e|str\./g, 'str').replace(/[^\p{L}]/gu, '');
    return `${street}|${m[2]}|${m[3]}`;
  };
  const [ka, kb] = [key(a), key(b)];
  return ka !== null && ka === kb;
}

/**
 * Каждая страница официальная (и после переадресаций) и открывается; адрес ещё на странице ведомства (или в addressSource), email — в её
 * HTML (часто только в mailto:), запись Schulaufsicht — в справочнике под заголовком своего округа, цитаты ролей — в документах
 * SenBJF; в снимке есть каждый округ из `bezirke`.
 */
export async function verifySchulamt(snap: Schulamt, fetchUrl: (url: string) => Promise<Fetched>, bezirke: string[] = []): Promise<string[]> {
  const pages = new Map<string, Promise<{ text: string; html: string }>>();
  const load = (url: string) => {
    if (!pages.has(url))
      pages.set(
        url,
        fetchUrl(url).then(async (f) => {
          if (sourceKind(url) !== 'official' || sourceKind(f.url) !== 'official') throw new Error(`${new URL(f.url).hostname}: не официальный источник (config.context.officialSources)`);
          if (f.status >= 400) throw new Error(`HTTP ${f.status}`);
          return { text: normalize(await pageText(f)), html: f.body.toString('utf8').toLowerCase() };
        }),
      );
    return pages.get(url)!;
  };
  const problems: string[] = [];
  const failed = new Set<string>();
  const page = (url: string) =>
    load(url).catch((e) => {
      if (!failed.has(url)) problems.push(`${url}: ${(e as Error).message}`); // ошибку загрузки называем один раз
      failed.add(url);
      return null;
    });
  for (const [name, role] of Object.entries(snap.roles)) {
    const p = await page(role.url);
    if (p && !findQuote(p.text, role.quote)) problems.push(`${name}: цитаты «${role.quote.slice(0, 60)}…» больше нет на ${role.url}`);
  }
  for (const [bezirk, offices] of Object.entries(snap.bezirke)) {
    for (const [kind, o] of Object.entries(offices)) {
      const p = await page(o.url);
      const where = o.addressSource ?? o.url;
      const a = o.addressSource ? await page(o.addressSource) : p;
      if (o.address && a && !hasAddress(a.text, o.address)) problems.push(`${bezirk} ${kind}: адреса «${o.address}» больше нет на ${where}`);
      if (o.email && p && !p.html.includes(o.email.toLowerCase())) problems.push(`${bezirk} ${kind}: email ${o.email} больше нет на ${o.url}`);
    }
    // одним куском: так адрес, телефон и ящик привязаны к заголовку своего округа, а не к соседнему
    const d = offices.schulaufsicht.directory;
    const dir = await page(snap.directory.url);
    if (dir && !findQuote(dir.text, `${bezirk} ${d.address} Tel.: ${d.phone} E-Mail: ${d.email}`))
      problems.push(`${bezirk} schulaufsicht: в справочнике ${snap.directory.url} запись округа изменилась (адрес, телефон или ящик)`);
  }
  const missing = bezirke.filter((b) => !snap.bezirke[b]);
  if (missing.length) problems.push(`нет записи для округов: ${missing.join(', ')}`);
  return problems;
}
