import { readFileSync } from 'node:fs';
import { request, type APIRequestContext } from 'playwright';
import { z } from 'zod';

const Config = z.object({
  esbLayer: z.string().regex(/^esb_\d{4}$/),
  trendYears: z.number().int().min(1),
  neighbors: z.number().int().min(0),
  maxAddresses: z.number().int().min(1),
  defaultAddress: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  // ручные поправки «код зоны → bsn школы» из PDF района; приоритет над пространственным сопоставлением
  esbOverrides: z.record(z.string(), z.string()),
  // факты из официальных источников в начале отчёта (src/context.ts)
  context: z.object({
    pastMonths: z.number().int().min(1), // публикации не старше
    futureMonths: z.number().int().min(0), // план, который наступит не позже
    plannedMaxAgeMonths: z.number().int().min(1), // …но и сам план объявлен не раньше
    maxItems: z.number().int().min(1),
    maxPerCategory: z.number().int().min(1),
    officialSources: z.array(z.string()).min(1), // «домен[/начало пути]», домен — с поддоменами
    mirrorHosts: z.array(z.string()), // сайты фракций с копиями официальных ответов
  }),
});

export const config = Config.parse(
  JSON.parse(readFileSync(new URL('../config/config.json', import.meta.url), 'utf8')),
);

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
