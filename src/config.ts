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
