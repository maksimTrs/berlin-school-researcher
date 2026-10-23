import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config, newApi } from './config.js';
import { ContextSchema, Draft, fetchFollowing, PlzContextSchema, PlzDraft, readContext, verifyDraft, type Context, type PlzContext } from './context.js';
import { KEY_FIGURES, keyFigure } from './extract.js';
import { catchment, formatAddress, geocode, neighbors, plzZones, resolveStatus, type School } from './geo.js';
import { collectSchool, launchBrowser } from './portrait.js';
import { firstLine, preflight } from './preflight.js';
import {
  plzTitle,
  renderPlzReport,
  renderReport,
  share,
  type AddressResult,
  type PlzResult,
  type PlzSchool,
  type SchoolEntry,
} from './report.js';
import { Input, parseAddress, PlzQuery, type AddressQuery } from './schema.js';
import { scoreProblems, scoreSchool, verdict } from './score.js';
import { diffSchools, fetchStartchancen, saveSnapshot, startchancen } from './startchancen.js';

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: 'string' },
    address: { type: 'string' },
    plz: { type: 'string' },
    street: { type: 'string' },
    dir: { type: 'string' },
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
        status: resolveStatus(q, candidates),
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
          schools.push({ school, role, data: await collectSchool(page, school.bsn, role === 'main' ? 'full' : 'key', screensDir) });
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
    // проверенные факты прошлого прогона не теряются при повторном lookup; дата проверки — в отчёте
    writeFileSync(join(dir, 'report.html'), renderReport(result, readContext(dir, ContextSchema)));
    return { result, dir };
  } finally {
    await api.dispose();
  }
}

const brief = (ctx: Context) => ({
  bsn: ctx.bsn,
  items: ctx.items.map(({ category, published, planned, summaryRu, url }) => ({ category, published, planned, summaryRu, url })),
  rejected: ctx.rejected,
});

/**
 * Черновик Claude (context.draft.json) → каждый источник скачан и сверен → context.json и report.html заново.
 * Папка lookup — одна закреплённая школа; папка plz — по черновику на каждую школу зон.
 */
async function contextCmd() {
  if (!args.dir) throw new Error('Нужен --dir out/<адрес> — папка отчёта из lookup или plz');
  const dir = resolve(args.dir);
  const raw = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  const draftJson = JSON.parse(readFileSync(join(dir, 'context.draft.json'), 'utf8'));
  const api = await newApi();
  const fetchUrl = fetchFollowing(api);
  try {
    if ('zones' in raw) {
      const result = raw as PlzResult;
      const ctx: PlzContext = { schools: [] };
      const skipped: { bsn: string; reason: string }[] = [];
      for (const d of PlzDraft.parse(draftJson).schools) {
        // школа без Schulporträt (в warnings) или не из зон — пропускаем, остальные школы проверяем
        const s = result.schools.find((x) => x.school.bsn === d.bsn);
        if (!s) skipped.push({ bsn: d.bsn, reason: 'нет среди школ с данными в result.json' });
        else ctx.schools.push(await verifyDraft(d, s.school, s.data.profile, fetchUrl, new Date(), config.context.plzMaxItemsPerSchool));
      }
      writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
      writeFileSync(join(dir, 'report.html'), renderPlzReport(result, ctx));
      console.log(JSON.stringify({ schools: ctx.schools.map(brief), skipped, report: join(dir, 'report.html') }, null, 2));
      return;
    }
    const result = raw as AddressResult;
    const main = result.schools[0];
    if (result.status !== 'ok' || !main) throw new Error(`${dir}: в result.json нет закреплённой школы`);
    const ctx = await verifyDraft(Draft.parse(draftJson), main.school, main.data.profile, fetchUrl);
    writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
    writeFileSync(join(dir, 'report.html'), renderReport(result, ctx));
    console.log(JSON.stringify({ ...brief(ctx), report: join(dir, 'report.html') }, null, 2));
  } finally {
    await api.dispose();
  }
}

/** Короткая сводка в stdout — её читает skill, чтобы написать итог в чат. */
function summarize({ result: r, dir }: { result: AddressResult; dir: string | null }) {
  const main = r.schools[0];
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
    verdict: main ? verdict(scoreSchool(main.data)).text : null,
    startchancen: main ? startchancen().schools.includes(main.school.bsn) : null,
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

/** Все зоны PLZ (или улицы в нём) → школа каждой зоны с маркером за 3 года, без скриншотов. */
async function plzOne(q: PlzQuery): Promise<{ result: PlzResult; dir: string | null }> {
  const api = await newApi();
  try {
    const { total, zones } = await plzZones(api, q);
    const base = { input: q, generatedAt: new Date().toISOString(), esbLayer: config.esbLayer };
    if (!total) {
      return { result: { ...base, status: 'not_found', addresses: 0, zones: [], schools: [], warnings: [] }, dir: null };
    }
    const dir = resolve(args.out!, slugify(`plz ${q.plz} ${q.street ?? ''}`));
    mkdirSync(dir, { recursive: true });
    // одна школа бывает в нескольких зонах (ближайшая к двум зонам без своей школы) — собираем её один раз
    const unique = [...new Map(zones.flatMap((z) => z.schools).map((s): [string, School] => [s.bsn, s])).values()];
    const browser = await launchBrowser({
      headed: args.headed!,
      slowmo: Number(args.slowmo),
      tracePath: args.trace ? join(dir, 'trace.zip') : null,
    });
    const schools: PlzSchool[] = [];
    const warnings: string[] = [];
    try {
      const page = await browser.context.newPage();
      for (const school of unique) {
        try {
          schools.push({ school, data: await collectSchool(page, school.bsn, 'score', dir) });
        } catch (e) {
          warnings.push(`${school.name} (${school.bsn}): Schulporträt не загрузился — ${firstLine(e)}`);
        }
      }
    } finally {
      await browser.close();
    }

    const result: PlzResult = { ...base, status: 'ok', addresses: total, zones, schools, warnings };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(dir, 'report.html'), renderPlzReport(result, readContext(dir, PlzContextSchema)));
    return { result, dir };
  } finally {
    await api.dispose();
  }
}

function summarizePlz({ result: r, dir }: { result: PlzResult; dir: string | null }) {
  const data = new Map(r.schools.map((s) => [s.school.bsn, s.data]));
  return {
    input: plzTitle(r.input),
    status: r.status,
    addresses: r.addresses,
    zones: r.zones.map((z) => ({
      esb: z.esb,
      addresses: z.addresses,
      share: share(z.addresses, r.addresses),
      catchmentStatus: z.status,
      schools: z.schools.map((s) => {
        const d = data.get(s.bsn);
        return {
          school: d?.profile.name || s.name,
          bsn: s.bsn,
          verdict: d ? verdict(scoreSchool(d)).text : null,
          startchancen: startchancen().schools.includes(s.bsn),
        };
      }),
    })),
    outside: r.addresses - r.zones.reduce((n, z) => n + z.addresses, 0),
    warnings: r.warnings,
    report: dir && join(dir, 'report.html'),
    result: dir && join(dir, 'result.json'),
  };
}

async function plzCmd() {
  const q = PlzQuery.parse({ plz: args.plz, street: args.street ?? null });
  if (!(await sitesAvailable())) return;
  try {
    console.log(JSON.stringify(summarizePlz(await plzOne(q)), null, 2));
  } catch (e) {
    console.log(JSON.stringify({ input: plzTitle(q), status: 'error', error: firstLine(e) }, null, 2));
    process.exitCode = 1;
  }
}

/**
 * Ежемесячная проверка: эталонный адрес проходит весь путь, ключевые подстраницы текущего года отдают данные,
 * входы маркера — за каждый год тренда.
 */
async function canaryCmd() {
  if (!(await sitesAvailable())) return;
  const problems: string[] = [];
  // сбой основной школы — тоже проблема в JSON, а не стектрейс; сверку Startchancen всё равно делаем
  const run = await lookupOne(parseAddress(config.defaultAddress)).catch((e) => {
    problems.push(`lookup «${config.defaultAddress}»: ${firstLine(e)}`);
    return null;
  });
  const result = run?.result;
  if (result && result.status !== 'ok') problems.push(`адрес «${config.defaultAddress}» не найден в adressen_berlin`);
  const main = result?.schools[0];
  if (main) {
    if (!main.data.profile.name) problems.push('Schulportrait: пустое название школы (#ContentPlaceHolderMenuListe_lblSchulname)');
    // пропуски (fehl) у начальных школ законно бывают «н/д» — их не проверяем
    for (const k of KEY_FIGURES.filter((k) => k.page !== 'fehl')) {
      const yp = main.data.pages[k.page]?.[0];
      if (!yp) problems.push(`${k.page}: подстраница не загружена`);
      else if (yp.data.status === 'no_data') problems.push(`${k.page} ${yp.year}: «keine Daten» или таблица не найдена`);
      else if (keyFigure(yp.data, k.row, k.col) === null) problems.push(`${k.page} ${yp.year}: нет поля «${k.row ?? 'последняя строка'}» (${k.key})`);
    }
    problems.push(...scoreProblems(main.data, config.trendYears));
    if (main.data.screenshots.length !== 10) problems.push(`скриншотов ${main.data.screenshots.length}, ожидалось 10`);
  }
  // снимок списка Startchancen в репозитории ещё совпадает с сайтом
  const api = await newApi();
  try {
    const { added, removed } = diffSchools(startchancen().schools, await fetchStartchancen(api));
    if (added.length || removed.length) {
      problems.push(
        `Startchancen: список изменился (+${added.join(', ') || '—'}; −${removed.join(', ') || '—'}) — запусти npm run update:startchancen и закоммить`,
      );
    }
  } catch (e) {
    problems.push(`Startchancen: ${firstLine(e)} — снимок config/startchancen.json не сверен`);
  } finally {
    await api.dispose();
  }
  // «keine Daten» текущего года vunt называют и KEY_FIGURES, и scoreProblems — одной строкой
  console.log(JSON.stringify({ ok: problems.length === 0, problems: [...new Set(problems)], summary: run && summarize(run) }, null, 2));
  if (problems.length) process.exitCode = 1;
}

/** Перезаписывает снимок списка Startchancen с сайта; что изменилось — в stdout. */
async function startchancenCmd() {
  const api = await newApi();
  try {
    const live = await fetchStartchancen(api);
    let before: string[] = [];
    try {
      before = startchancen().schools;
    } catch {
      // снимка нет или он испорчен — запишем с нуля
    }
    saveSnapshot(live);
    console.log(JSON.stringify({ schools: live.length, ...diffSchools(before, live) }, null, 2));
  } finally {
    await api.dispose();
  }
}

const commands: Record<string, () => Promise<void>> = {
  resolve: resolveCmd,
  lookup: lookupCmd,
  plz: plzCmd,
  context: contextCmd,
  canary: canaryCmd,
  preflight: preflightCmd,
  startchancen: startchancenCmd,
};
const cmd = commands[positionals[0]];
if (!cmd) {
  console.error(
    'Использование: tsx src/cli.ts resolve|lookup|plz|context|canary|preflight|startchancen [--input f.json | --address "..." | --plz 10439 [--street "..."] | --dir out/<адрес>] [--headed --slowmo N --trace]',
  );
  process.exit(2);
}
await cmd();
