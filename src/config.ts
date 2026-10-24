import { readFileSync } from 'node:fs';
import { request, type APIRequestContext } from 'playwright';
import { z } from 'zod';

const Config = z.object({
  trendYears: z.number().int().min(1),
  neighbors: z.number().int().min(0),
  maxAddresses: z.number().int().min(1),
  defaultAddress: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  // ручные поправки «код зоны → bsn школы» из справочника района; список — общая зона нескольких школ (gemeinsamer ESB);
  // приоритет над пространственным сопоставлением. Коды зон — слоя текущего учебного года (currentEsbLayer): после 1 августа canary сверяет их с новым
  esbOverrides: z.record(z.string(), z.union([z.string().regex(/^\d{2}[A-Z]\d{2}$/), z.array(z.string().regex(/^\d{2}[A-Z]\d{2}$/)).min(2).refine((l) => new Set(l).size === l.length, 'школа дважды в поправке')])),
  // школы без своей зоны (SESB — «überbezirkliches Angebot»), стоящие в чужой: bsn → почему, строкой в отчёт; источник — таблица в README
  schoolsWithoutZone: z.record(z.string().regex(/^\d{2}[A-Z]\d{2}$/), z.string().min(10)),
  // факты из официальных источников в начале отчёта (src/context.ts)
  context: z.object({
    pastMonths: z.number().int().min(1), // публикации не старше
    futureMonths: z.number().int().min(0), // план, который наступит не позже
    plannedMaxAgeMonths: z.number().int().min(1), // …но и сам план объявлен не раньше
    maxItems: z.number().int().min(1),
    plzMaxItemsPerSchool: z.number().int().min(1), // в отчёте по PLZ школ несколько — фактов на каждую меньше
    maxPerCategory: z.number().int().min(1),
    officialSources: z.array(z.string()).min(1), // «домен[/начало пути]», домен — с поддоменами
    mirrorHosts: z.array(z.string()), // сайты фракций с копиями официальных ответов
  }),
});

/**
 * Слой зон текущего учебного года: esb_2026 — «Einschulbereiche - Schuljahr 2026/2027» (GetCapabilities),
 * следующий — «(Planung)», ещё может измениться. Учебный год — с 1 августа по Берлину (с этого дня Schulpflicht).
 * Слоя ещё нет — preflight не пропустит, прошлогодний не подставляем.
 */
export function currentEsbLayer(now = new Date()): string {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' })
    .format(now)
    .split('-')
    .map(Number);
  return `esb_${m >= 8 ? y : y - 1}`;
}

export const config = {
  ...Config.parse(JSON.parse(readFileSync(new URL('../config/config.json', import.meta.url), 'utf8'))),
  esbLayer: currentEsbLayer(),
};

export const isRemote = process.env.CLAUDE_CODE_REMOTE === 'true';

// Chromium и APIRequestContext не читают HTTPS_PROXY сами — в облачной сессии трафик идёт через прокси.
const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;
export const network = {
  proxy: proxyServer ? { server: proxyServer } : undefined,
  ignoreHTTPSErrors: isRemote,
};

export function newApi(): Promise<APIRequestContext> {
  return request.newContext({ ...network, timeout: 30_000 });
}
