import type { APIRequestContext } from 'playwright';
import { config } from './config.js';

const wfs = (service: string, layer: string) =>
  `https://gdi.berlin.de/services/wfs/${service}?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&count=1&typeNames=${service}:${layer}`;

/** Только источники, без которых отчёт не собрать. Google Maps — лишь ссылки в отчёте, его не проверяем. */
const CHECKS = [
  { name: 'Адресный реестр (WFS adressen_berlin)', url: wfs('adressen_berlin', 'adressen_berlin'), expect: 'FeatureCollection' },
  { name: `Зоны Einschulbereich (WFS esb:${config.esbLayer})`, url: wfs('esb', config.esbLayer), expect: 'FeatureCollection' },
  { name: 'Школы (WFS schulen)', url: wfs('schulen', 'schulen'), expect: 'FeatureCollection' },
  { name: 'Schulverzeichnis (поиск школы)', url: 'https://www.bildung.berlin.de/Schulverzeichnis/', expect: 'txtSuchbegriff' },
];

export type CheckResult = { name: string; url: string; ok: boolean; error?: string };

export async function preflight(api: APIRequestContext): Promise<CheckResult[]> {
  return Promise.all(
    CHECKS.map(async ({ name, url, expect }): Promise<CheckResult> => {
      try {
        const res = await api.get(url, { timeout: 15_000 });
        if (!res.ok()) return { name, url, ok: false, error: `HTTP ${res.status()}` };
        if (!(await res.text()).includes(expect)) {
          return { name, url, ok: false, error: `в ответе нет «${expect}» — сменился формат или вёрстка` };
        }
        return { name, url, ok: true };
      } catch (e) {
        return { name, url, ok: false, error: firstLine(e) };
      }
    }),
  );
}

export const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];
