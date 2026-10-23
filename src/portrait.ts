import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config, isRemote, network } from './config.js';
import {
  availableYears,
  captionYear,
  extractInspections,
  extractPage,
  extractProfile,
  KEY_FIGURES,
  PAGES,
  type PageData,
  type PageKey,
  type Profile,
} from './extract.js';

const SCHULVERZEICHNIS = 'https://www.bildung.berlin.de/Schulverzeichnis/';

export type BrowserOptions = { headed: boolean; slowmo: number; tracePath: string | null };

export async function launchBrowser(opts: BrowserOptions): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  if (opts.headed && isRemote) console.warn('--headed игнорируется в облачной сессии: нет дисплея');
  const browser = await chromium.launch({
    headless: !opts.headed || isRemote,
    slowMo: opts.slowmo,
    proxy: network.proxy,
  });
  const context = await browser.newContext({ viewport: config.viewport, ignoreHTTPSErrors: network.ignoreHTTPSErrors });
  if (opts.tracePath) await context.tracing.start({ screenshots: true, snapshots: true });
  return {
    context,
    close: async () => {
      if (opts.tracePath) await context.tracing.stop({ path: opts.tracePath });
      await browser.close();
    },
  };
}

export type YearPage = { year: string; data: PageData };

export type SchoolData = {
  bsn: string;
  portraitUrl: string;
  profile: Profile;
  pages: Partial<Record<PageKey, YearPage[]>>; // годы от нового к старому
  inspections: { label: string; url: string }[];
  screenshots: { title: string; file: string }[];
};

/** Поиск по номеру школы открывает Schulportrait и кладёт школу в ASP.NET-сессию — подстраницы ниже относятся к ней. */
async function openSchool(page: Page, bsn: string): Promise<string> {
  await page.goto(SCHULVERZEICHNIS);
  await page.locator('#txtSuchbegriff').fill(bsn); // не #searchFormInput_q — это общий поиск berlin.de
  await page.locator('#txtSuchbegriff').press('Enter');
  const portrait = /Schulportrait\.aspx\?IDSchulzweig=\d+/;
  await page.waitForURL(new RegExp(`${portrait.source}|SchulListe\\.aspx`));
  if (!portrait.test(page.url())) {
    // у Gemeinschaftsschule несколько Schulzweige под одним номером — берём ветку Grundschule
    const entries = page.locator('#DataListSchulen td');
    const primary = entries.filter({ has: page.locator('[id^="DataListSchulen_lblSchulart_"]', { hasText: /^Grundschule$/ }) });
    await ((await primary.count()) ? primary : entries).first().locator('a').click();
    await page.waitForURL(portrait);
  }
  return page.url();
}

// '2025/26', 2 → ['2024/25', '2023/24']
export const previousYears = (year: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const start = Number(year.slice(0, 4)) - i - 1;
    return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
  });

/**
 * full = true: все подстраницы, тренд за config.trendYears лет, инспекция и полностраничные скриншоты текущего года в screensDir.
 * full = false: только текущий год подстраниц, нужных для KEY_FIGURES (компактная строка соседней школы).
 */
export async function collectSchool(page: Page, bsn: string, full: boolean, screensDir: string): Promise<SchoolData> {
  const portraitUrl = await openSchool(page, bsn);
  const result: SchoolData = {
    bsn,
    portraitUrl,
    profile: extractProfile(await page.content()),
    pages: {},
    inspections: [],
    screenshots: [],
  };
  const urlOf = (rel: string) => new URL(rel, portraitUrl).toString();
  // HTTP-запрос в той же сессии (cookie контекста) — быстрее навигации браузера
  const fetchHtml = async (rel: string) => {
    const res = await page.request.get(urlOf(rel), { maxRetries: 2 });
    if (!res.ok()) throw new Error(`${bsn} ${rel}: HTTP ${res.status()}`);
    return res.text();
  };
  const screenshot = async (title: string, name: string, rel?: string) => {
    if (rel) await page.goto(urlOf(rel));
    const file = join(screensDir, `${bsn}_${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    result.screenshots.push({ title, file });
  };

  if (full) await screenshot('Профиль школы', 'portrait');
  const keyPages = new Set<string>(KEY_FIGURES.map((k) => k.page));
  for (const p of PAGES) {
    if (!full && !keyPages.has(p.key)) continue;
    const html = await fetchHtml(p.path);
    const current = extractPage(html);
    const year = captionYear(current) ?? availableYears(html, p.path)[0] ?? 'текущий год';
    const years: YearPage[] = [{ year, data: current }];
    if (full && p.trend && /^\d{4}\//.test(year)) {
      for (const y of previousYears(year, config.trendYears - 1)) {
        years.push({ year: y, data: extractPage(await fetchHtml(`${p.path}&jahr=${encodeURIComponent(y)}`)) });
      }
    }
    result.pages[p.key] = years;
    if (full) await screenshot(p.title, p.key, p.path);
  }
  if (full) {
    result.inspections = extractInspections(await fetchHtml('schulinspektion.aspx'), portraitUrl);
    await screenshot('Инспекция', 'inspektion', 'schulinspektion.aspx');
  }
  return result;
}
