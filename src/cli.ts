import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config, newApi } from './config.js';
import { KEY_FIGURES, keyFigure } from './extract.js';
import { catchment, formatAddress, geocode, neighbors } from './geo.js';
import { collectSchool, launchBrowser } from './portrait.js';
import { firstLine, preflight } from './preflight.js';
import { renderReport, type AddressResult, type SchoolEntry } from './report.js';
import { Input, parseAddress, type AddressQuery } from './schema.js';

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: 'string' },
    address: { type: 'string' },
    out: { type: 'string', default: 'out' },
    headed: { type: 'boolean', default: false },
    slowmo: { type: 'string', default: '0' },
    trace: { type: 'boolean', default: false },
  },
});

function readAddresses(): AddressQuery[] {
  if (args.address) return [parseAddress(args.address)];
  if (args.input) return Input.parse(JSON.parse(readFileSync(args.input, 'utf8'))).addresses;
  throw new Error('Нужен --input input.json или --address "Straße Nr, PLZ"');
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

async function resolveCmd() {
  const api = await newApi();
  try {
    const results = [];
    for (const q of readAddresses()) {
      const candidates = await geocode(api, q);
      results.push({
        raw: q.raw ?? `${q.street} ${q.house}`,
        status: candidates.length === 1 ? 'exact' : candidates.length ? 'ambiguous' : 'none',
        candidates,
      });
    }
    writeFileSync('resolve.json', JSON.stringify({ results }, null, 2));
    console.log(JSON.stringify({ results }, null, 2));
  } finally {
    await api.dispose();
  }
}

async function lookupOne(q: AddressQuery): Promise<{ result: AddressResult; dir: string | null }> {
  const api = await newApi();
  try {
    const candidates = await geocode(api, q);
    const base = { input: q, generatedAt: new Date().toISOString(), esbLayer: config.esbLayer };
    if (!candidates.length) {
      return {
        result: { ...base, status: 'not_found', address: null, alternatives: [], catchment: null, schools: [], warnings: [] },
        dir: null,
      };
    }
    const [addr, ...alternatives] = candidates;
    const c = await catchment(api, addr);
    const near = await neighbors(api, addr, c.schools, config.neighbors);

    const dir = resolve(args.out!, slugify(formatAddress(addr)));
    const screensDir = join(dir, 'screens');
    mkdirSync(screensDir, { recursive: true });
    const browser = await launchBrowser({
      headed: args.headed!,
      slowmo: Number(args.slowmo),
      tracePath: args.trace ? join(dir, 'trace.zip') : null,
    });
    const schools: SchoolEntry[] = [];
    const warnings: string[] = [];
    try {
      const page = await browser.context.newPage();
      const plan = [
        ...c.schools.map((school, i) => ({ school, role: i === 0 ? ('main' as const) : ('candidate' as const) })),
        ...near.map((school) => ({ school, role: 'neighbor' as const })),
      ];
      for (const { school, role } of plan) {
        try {
          schools.push({ school, role, data: await collectSchool(page, school.bsn, role === 'main', screensDir) });
        } catch (e) {
          // без основной школы отчёта нет; кандидат или сосед — только строка в отчёте
          if (role === 'main') throw e;
          warnings.push(`${school.name} (${school.bsn}): Schulporträt не загрузился — ${firstLine(e)}`);
        }
      }
    } finally {
      await browser.close();
    }

    const result: AddressResult = { ...base, status: 'ok', address: addr, alternatives, catchment: c, schools, warnings };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(dir, 'report.html'), renderReport(result));
    return { result, dir };
  } finally {
    await api.dispose();
  }
}

/** Короткая сводка в stdout — её читает skill, чтобы написать итог в чат. */
function summarize({ result: r, dir }: { result: AddressResult; dir: string | null }) {
  const main = r.schools[0];
  const current = (k: (typeof KEY_FIGURES)[number]['key']) => {
    const def = KEY_FIGURES.find((x) => x.key === k)!;
    const yp = main?.data.pages[def.page]?.[0];
    return yp ? { year: yp.year, value: keyFigure(yp.data, def.row, def.col) } : null;
  };
  return {
    input: r.input.raw ?? `${r.input.street} ${r.input.house}`,
    status: r.status,
    address: r.address && formatAddress(r.address),
    alternatives: r.alternatives.map(formatAddress),
    esb: r.catchment?.esb ?? null,
    catchmentStatus: r.catchment?.status ?? null,
    school: main ? `${main.data.profile.name || main.school.name}` : null,
    bsn: main?.school.bsn ?? null,
    candidates: r.schools.filter((s) => s.role === 'candidate').map((s) => `${s.school.name} (${s.school.bsn})`),
    warnings: r.warnings,
    ausfall: current('ausfall'),
    ausfallBerlin: current('ausfallBerlin'),
    report: dir && join(dir, 'report.html'),
    result: dir && join(dir, 'result.json'),
  };
}

/** Не запускаем браузер, если недоступен хоть один критичный источник: печатаем, какой, exit code 2. */
async function sitesAvailable(): Promise<boolean> {
  const api = await newApi();
  try {
    const checks = await preflight(api);
    if (checks.every((c) => c.ok)) return true;
    console.log(JSON.stringify({ preflight: 'failed', checks }, null, 2));
    process.exitCode = 2;
    return false;
  } finally {
    await api.dispose();
  }
}

async function preflightCmd() {
  const api = await newApi();
  try {
    const checks = await preflight(api);
    console.log(JSON.stringify({ preflight: checks.every((c) => c.ok) ? 'ok' : 'failed', checks }, null, 2));
    if (!checks.every((c) => c.ok)) process.exitCode = 2;
  } finally {
    await api.dispose();
  }
}

async function lookupCmd() {
  const addresses = readAddresses();
  if (!(await sitesAvailable())) return;
  const out = [];
  // сбой одного адреса (таймаут сайта, сменившаяся вёрстка) не должен терять остальные
  for (const q of addresses) {
    try {
      out.push(summarize(await lookupOne(q)));
    } catch (e) {
      out.push({ input: q.raw ?? `${q.street} ${q.house}`, status: 'error', error: firstLine(e) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
  if (out.some((s) => s.status === 'error')) process.exitCode = 1;
}

/** Ежемесячная проверка: эталонный адрес проходит весь путь, ключевые подстраницы текущего года отдают данные. */
async function canaryCmd() {
  if (!(await sitesAvailable())) return;
  const { result, dir } = await lookupOne(parseAddress(config.defaultAddress));
  const problems: string[] = [];
  if (result.status !== 'ok') problems.push(`адрес «${config.defaultAddress}» не найден в adressen_berlin`);
  const main = result.schools[0];
  if (main) {
    if (!main.data.profile.name) problems.push('Schulportrait: пустое название школы (#ContentPlaceHolderMenuListe_lblSchulname)');
    // пропуски (fehl) у начальных школ законно бывают «н/д» — их не проверяем
    for (const k of KEY_FIGURES.filter((k) => k.page !== 'fehl')) {
      const yp = main.data.pages[k.page]?.[0];
      if (!yp) problems.push(`${k.page}: подстраница не загружена`);
      else if (yp.data.status === 'no_data') problems.push(`${k.page} ${yp.year}: «keine Daten» или таблица не найдена`);
      else if (keyFigure(yp.data, k.row, k.col) === null) problems.push(`${k.page} ${yp.year}: нет поля «${k.row ?? 'последняя строка'}» (${k.key})`);
    }
    if (main.data.screenshots.length !== 10) problems.push(`скриншотов ${main.data.screenshots.length}, ожидалось 10`);
  }
  console.log(JSON.stringify({ ok: problems.length === 0, problems, summary: summarize({ result, dir }) }, null, 2));
  if (problems.length) process.exitCode = 1;
}

const commands: Record<string, () => Promise<void>> = {
  resolve: resolveCmd,
  lookup: lookupCmd,
  canary: canaryCmd,
  preflight: preflightCmd,
};
const cmd = commands[positionals[0]];
if (!cmd) {
  console.error('Использование: tsx src/cli.ts resolve|lookup|canary|preflight [--input f.json | --address "..."] [--headed --slowmo N --trace]');
  process.exit(2);
}
await cmd();
