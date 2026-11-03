import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { config, newApi } from './config.js';
import { AddressContextSchema, claudeSearched, Draft, farPlan, fetchFollowing, onSchoolSite, PlzContextSchema, PlzDraft, readContext, verifyDraft, type Context, type PlzContext } from './context.js';
import { district, districtFacts, districtStale, verifyDistrict } from './district.js';
import { currentFigures, KEY_FIGURES, keyFigure, type Profile } from './extract.js';
import { basemap, catchment, checkOverrides, checkWithoutZone, formatAddress, geocode, neighbors, onStreet, overridesStale, overrideIgnored, plzZones, primarySchools, resolveStatus, type School } from './geo.js';
import { collectSchool, launchBrowser } from './portrait.js';
import { firstLine, preflight } from './preflight.js';
import {
  MAP_W,
  mapFrame,
  plzTitle,
  renderPlzReport,
  renderReport,
  share,
  type AddressResult,
  type PlzResult,
  type PlzSchool,
  type SchoolEntry,
} from './report.js';
import { Input, parseAddress, PlzInput, PlzQuery, type AddressQuery } from './schema.js';
import { verifySchulamt, schulamt } from './schulamt.js';
import { scoreProblems, scoreSchool, verdict } from './score.js';
import { diffSchools, fetchStartchancen, saveSnapshot, startchancen } from './startchancen.js';
import { verifyZuzug, zuzug } from './zuzug.js';

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    input: { type: 'string' },
    address: { type: 'string' },
    plz: { type: 'string' },
    ortsteil: { type: 'string' },
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

type Facts = ReturnType<typeof districtFacts>;

/** Факты документов округа без поиска Claude (queries пустой — в отчёте «поиск не проводился»); нечего показать — null. */
async function districtOnly(facts: Facts, school: School, profile: Profile, fetchUrl: ReturnType<typeof fetchFollowing>, maxItems: number): Promise<Context | null> {
  const f = await facts(school);
  return f.items.length || f.rejected.length ? verifyDraft({ bsn: school.bsn, queries: [], items: [] }, school, profile, fetchUrl, new Date(), maxItems, f) : null;
}

/**
 * context.json без поиска Claude (его писали lookup/plz) пересчитывается при каждом прогоне — иначе сбой berlin.de (429)
 * застревал бы в нём навсегда; с находками Claude — не трогаем, его обновляет npm run context.
 */
const districtOnlyContext = (dir: string) => {
  if (!existsSync(join(dir, 'context.json'))) return true;
  const ctx = readContext(dir, AddressContextSchema);
  return ctx !== null && !claudeSearched(ctx); // файл не читается — не трогаем: в нём могут быть проверенные находки Claude
};

/** Испорченный config/district.json не должен стоить отчёта после прогона браузера: отчёт — без фактов округа, причина — в stderr. */
async function keepReport(step: () => Promise<void>) {
  try {
    await step();
  } catch (e) {
    console.error(`⚠️ Документы округа пропущены: ${firstLine(e)} — проверь config/district.json (npm test)`);
  }
}

function writeDistrictContext(dir: string, found: Context[], joint: boolean) {
  if (found.length) writeFileSync(join(dir, 'context.json'), JSON.stringify(joint ? { schools: found } : found[0], null, 2));
  else rmSync(join(dir, 'context.json'), { force: true }); // документы округа о школах больше ничего не дают
}

async function lookupOne(q: AddressQuery): Promise<{ result: AddressResult; dir: string | null }> {
  const api = await newApi();
  try {
    // соседняя улица («Am Waldidyll» на «Am Wald») — не этот адрес: not_found, skill вернётся к resolve
    const candidates = onStreet(q, await geocode(api, q));
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
    const warnings: string[] = [overrideIgnored(c)].filter((w) => w !== null);
    try {
      const page = await browser.context.newPage();
      // общая зона: остальные её школы тоже закреплены — маркер за годы тренда (score), а не только текущий год
      const other = c.status === 'joint' ? ('joint' as const) : ('candidate' as const);
      const plan = [
        ...c.schools.map((school, i) => ({ school, role: i === 0 ? ('main' as const) : other })),
        ...near.map((school) => ({ school, role: 'neighbor' as const })),
      ];
      const depth = { main: 'full', joint: 'score', candidate: 'key', neighbor: 'key' } as const;
      for (const { school, role } of plan) {
        try {
          schools.push({ school, role, data: await collectSchool(page, school.bsn, depth[role], screensDir) });
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
    // документы округа — и без Claude: первый прогон пишет context.json с ними; npm run context потом добавит находки поиска
    if (districtOnlyContext(dir)) {
      await keepReport(async () => {
        const fetchUrl = fetchFollowing(api);
        const facts = districtFacts(fetchUrl);
        const assigned = schools.filter((s) => s.role === 'main' || s.role === 'joint');
        const found = (await Promise.all(assigned.map((s) => districtOnly(facts, s.school, s.data.profile, fetchUrl, config.context.maxItems)))).filter((x) => x !== null);
        writeDistrictContext(dir, found, c.status === 'joint');
      });
    }
    // проверенные факты прошлого прогона не теряются при повторном lookup; дата проверки — в отчёте
    writeFileSync(join(dir, 'report.html'), renderReport(result, readContext(dir, AddressContextSchema)));
    return { result, dir };
  } finally {
    await api.dispose();
  }
}

const brief = (ctx: Context) => ({
  bsn: ctx.bsn,
  items: ctx.items.map((i) => ({ category: i.category, published: i.published, planned: i.planned, longTerm: farPlan(i, ctx.window.plannedTo), rule: i.rule, summaryRu: i.summaryRu, url: i.url })),
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
  // переадресации на сайте школы (http → https, www) — только к сайтам школ этого отчёта
  const sites = (raw.schools as { school: School }[]).map((s) => s.school.web).filter((w) => !!w);
  const fetchUrl = fetchFollowing(api, (url) => sites.some((w) => onSchoolSite(url, w)));
  const facts = districtFacts(fetchUrl); // документы округа — один раз на все школы папки
  try {
    if ('zones' in raw) {
      const result = raw as PlzResult;
      const ctx: PlzContext = { schools: [] };
      const skipped: { bsn: string; reason: string }[] = [];
      for (const d of PlzDraft.parse(draftJson).schools) {
        // школа без Schulporträt (в warnings) или не из зон — пропускаем, остальные школы проверяем
        const s = result.schools.find((x) => x.school.bsn === d.bsn);
        if (!s) skipped.push({ bsn: d.bsn, reason: 'нет среди школ с данными в result.json' });
        else ctx.schools.push(await verifyDraft(d, s.school, s.data.profile, fetchUrl, new Date(), config.context.plzMaxItemsPerSchool, await facts(s.school)));
      }
      // школа зон без черновика — факты округа ей всё равно (иначе context стирал бы то, что записал plz)
      for (const s of result.schools.filter((x) => !ctx.schools.some((c) => c.bsn === x.school.bsn))) {
        const only = await districtOnly(facts, s.school, s.data.profile, fetchUrl, config.context.plzMaxItemsPerSchool);
        if (only) ctx.schools.push(only);
      }
      writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
      writeFileSync(join(dir, 'report.html'), renderPlzReport(result, ctx, readBasemap(dir)));
      console.log(JSON.stringify({ schools: ctx.schools.map(brief), skipped, report: join(dir, 'report.html') }, null, 2));
      return;
    }
    const result = raw as AddressResult;
    const main = result.schools[0];
    if (result.status !== 'ok' || !main) throw new Error(`${dir}: в result.json нет закреплённой школы`);
    const many = typeof draftJson === 'object' && draftJson !== null && 'schools' in draftJson;
    if (many || result.schools.some((x) => x.role === 'joint')) {
      // общая зона: по черновику на каждую закреплённую школу (main и joint); одиночный черновик — только о main,
      // остальным школам зоны — факты округа (иначе context.json потерял бы то, что о них записал lookup)
      const ctx: PlzContext = { schools: [] };
      const skipped: { bsn: string; reason: string }[] = [];
      for (const d of many ? PlzDraft.parse(draftJson).schools : [Draft.parse(draftJson)]) {
        const s = result.schools.find((x) => x.school.bsn === d.bsn && (x.role === 'main' || x.role === 'joint'));
        const assigned = result.catchment?.schools.some((x) => x.bsn === d.bsn);
        if (!s) skipped.push({ bsn: d.bsn, reason: assigned ? 'нет данных в result.json (Schulporträt не загрузился)' : 'не закреплённая школа этого адреса' });
        else ctx.schools.push(await verifyDraft(d, s.school, s.data.profile, fetchUrl, new Date(), config.context.maxItems, await facts(s.school)));
      }
      for (const s of result.schools.filter((x) => (x.role === 'main' || x.role === 'joint') && !ctx.schools.some((c) => c.bsn === x.school.bsn))) {
        const only = await districtOnly(facts, s.school, s.data.profile, fetchUrl, config.context.maxItems);
        if (only) ctx.schools.push(only);
      }
      writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx, null, 2));
      writeFileSync(join(dir, 'report.html'), renderReport(result, ctx));
      console.log(JSON.stringify({ schools: ctx.schools.map(brief), skipped, report: join(dir, 'report.html') }, null, 2));
      return;
    }
    const ctx = await verifyDraft(Draft.parse(draftJson), main.school, main.data.profile, fetchUrl, new Date(), config.context.maxItems, await facts(main.school));
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
    // стоят в зоне, но своей зоны нет — не закреплены (config.schoolsWithoutZone)
    withoutZone: (r.catchment?.withoutZone ?? []).map((s) => `${s.name} (${s.bsn})`),
    // общая зона: остальные закреплённые школы — с маркером, как основная; без Schulporträt — verdict null (см. warnings)
    joint: (r.catchment?.status === 'joint' ? r.catchment.schools.slice(1) : []).map((school) => {
      const d = r.schools.find((s) => s.role === 'joint' && s.school.bsn === school.bsn)?.data;
      return {
        school: d?.profile.name || school.name,
        bsn: school.bsn,
        verdict: d ? verdict(scoreSchool(d)).text : null,
        startchancen: startchancen().schools.includes(school.bsn),
      };
    }),
    warnings: r.warnings,
    verdict: main ? verdict(scoreSchool(main.data)).text : null,
    // цифры для 💭 в итоге: значения как на сайте, null — нет данных
    keyFigures: main ? currentFigures(main.data.pages) : null,
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

/** Все зоны PLZ и/или района (или улицы в них) → школа каждой зоны с маркером за 3 года, без скриншотов. */
async function plzOne(q: PlzQuery): Promise<{ result: PlzResult; dir: string | null }> {
  const api = await newApi();
  try {
    const { total, zones, excludedByOrtsteil } = await plzZones(api, q);
    // район назван неверно для PLZ — not_found всё равно скажет, в каких районах дома этого PLZ
    const base = { input: q, generatedAt: new Date().toISOString(), esbLayer: config.esbLayer, excludedByOrtsteil };
    if (!total) {
      return { result: { ...base, status: 'not_found', addresses: 0, zones: [], schools: [], warnings: [] }, dir: null };
    }
    // plz-10439, plz-10439-schivelbeiner-strasse, ortsteil-friedenau, ortsteil-friedenau-12161
    const slug = q.ortsteil ? `ortsteil ${q.ortsteil} ${q.plz ?? ''}` : `plz ${q.plz}`;
    const dir = resolve(args.out!, slugify(`${slug} ${q.street ?? ''}`));
    mkdirSync(dir, { recursive: true });
    // одна школа бывает в нескольких зонах (ближайшая к двум зонам без своей школы) — собираем её один раз
    const unique = [...new Map(zones.flatMap((z) => z.schools).map((s): [string, School] => [s.bsn, s])).values()];
    const browser = await launchBrowser({
      headed: args.headed!,
      slowmo: Number(args.slowmo),
      tracePath: args.trace ? join(dir, 'trace.zip') : null,
    });
    const schools: PlzSchool[] = [];
    const warnings: string[] = zones.map((z) => overrideIgnored(z)).filter((w) => w !== null);
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

    // подложка карты — не обязательна: недоступен basemap.de — карта без улиц, отчёт всё равно пишем
    const frame = mapFrame(zones);
    if (frame) {
      try {
        writeFileSync(join(dir, 'basemap.jpg'), await basemap(api, frame.bbox, MAP_W, frame.h));
      } catch (e) {
        console.error(`Подложка карты не загрузилась, карта без улиц: ${firstLine(e)}`);
      }
    }

    const result: PlzResult = { ...base, status: 'ok', addresses: total, zones, schools, warnings };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    // документы округа — каждой школе зон и без Claude (как в lookup)
    if (districtOnlyContext(dir)) {
      await keepReport(async () => {
        const fetchUrl = fetchFollowing(api);
        const facts = districtFacts(fetchUrl);
        const found: Context[] = [];
        for (const s of schools) {
          const ctx = await districtOnly(facts, s.school, s.data.profile, fetchUrl, config.context.plzMaxItemsPerSchool);
          if (ctx) found.push(ctx);
        }
        writeDistrictContext(dir, found, true);
      });
    }
    writeFileSync(join(dir, 'report.html'), renderPlzReport(result, readContext(dir, PlzContextSchema), readBasemap(dir)));
    return { result, dir };
  } finally {
    await api.dispose();
  }
}

/** basemap.jpg папки plz → data: URI для карты отчёта (artifact пропускает только встроенные картинки). */
const readBasemap = (dir: string) =>
  existsSync(join(dir, 'basemap.jpg')) ? `data:image/jpeg;base64,${readFileSync(join(dir, 'basemap.jpg')).toString('base64')}` : null;

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
      // по району — в каких PLZ дома зоны: объявление называет PLZ
      plzs: z.plzs.map((p) => `${p.plz}: ${p.addresses}`).join(', '),
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
      withoutZone: (z.withoutZone ?? []).map((s) => `${s.name} (${s.bsn})`),
    })),
    outside: r.addresses - r.zones.reduce((n, z) => n + z.addresses, 0),
    excludedByOrtsteil: r.excludedByOrtsteil ?? null,
    warnings: r.warnings,
    report: dir && join(dir, 'report.html'),
    result: dir && join(dir, 'result.json'),
  };
}

/** Один запрос (--plz/--ortsteil/--street) → объект; файл (--input) → массив сводок, по одной на запрос, как у lookup. */
async function plzCmd() {
  const batch = !!args.input;
  const queries = batch
    ? PlzInput.parse(JSON.parse(readFileSync(args.input!, 'utf8'))).queries
    : [PlzQuery.parse({ plz: args.plz ?? null, ortsteil: args.ortsteil ?? null, street: args.street ?? null })];
  if (!(await sitesAvailable())) return;
  const out = [];
  const seen = new Set<string>();
  // сбой одного запроса не теряет остальные; повтор того же запроса — та же папка, второй раз не собираем
  for (const q of queries) {
    const key = plzTitle(q).toLowerCase();
    if (seen.has(key)) {
      out.push({ input: plzTitle(q), status: 'skipped', error: 'повтор запроса выше' });
      continue;
    }
    seen.add(key);
    try {
      out.push(summarizePlz(await plzOne(q)));
    } catch (e) {
      out.push({ input: plzTitle(q), status: 'error', error: firstLine(e) });
    }
  }
  console.log(JSON.stringify(batch ? out : out[0], null, 2));
  if (out.some((s) => s.status === 'error')) process.exitCode = 1;
}

/**
 * Ежемесячная проверка: эталонный адрес проходит весь путь, ключевые подстраницы текущего года отдают данные,
 * входы маркера — за каждый год тренда; снимки Startchancen, правил переезда и Schulamt округов совпадают с сайтами.
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
  // сверки снимков и поправок с сайтами: сбой одной — строка в problems, остальные всё равно идут
  const api = await newApi();
  const check = async (what: string, run: () => Promise<string[]>) =>
    problems.push(...(await run().catch((e) => [`${what}: ${firstLine(e)} — не сверено`])));
  try {
    // снимок списка Startchancen в репозитории ещё совпадает с сайтом
    await check('Startchancen (config/startchancen.json)', async () => {
      const { added, removed } = diffSchools(startchancen().schools, await fetchStartchancen(api));
      return added.length || removed.length
        ? [`Startchancen: список изменился (+${added.join(', ') || '—'}; −${removed.join(', ') || '—'}) — запусти npm run update:startchancen и закоммить`]
        : [];
    });
    // поправки зон ещё указывают на существующие зону слоя и школы
    await check('esbOverrides', async () => [...overridesStale(), ...(await checkOverrides(api))]);
    // школы без своей зоны ещё в реестре и всё ещё без зоны — иначе устаревшая запись вычёркивала бы кандидата
    await check('schoolsWithoutZone', () => checkWithoutZone(api));
    // правила переезда посреди года: цитаты снимка ещё дословно в документах SenBJF
    await check('Переезд (config/zuzug.json)', async () =>
      (await verifyZuzug(zuzug(), fetchFollowing(api))).map((p) => `Переезд (config/zuzug.json): ${p} — найди новую формулировку и обнови снимок`),
    );
    // документы округа: открываются, строки инвестплана разбираются, цитаты и дата решения на месте
    await check('Документы округа (config/district.json)', async () =>
      (await verifyDistrict(district(), fetchFollowing(api))).map((p) => `Документы округа (config/district.json): ${p} — сверь документ и обнови снимок`),
    );
    // Schulamt и Schulaufsicht округов: адрес и email ещё на страницах ведомств, запись есть у каждого округа школ реестра
    await check('Schulamt (config/schulamt.json)', async () => {
      const bezirke = [...new Set((await primarySchools(api)).map((s) => s.bezirk))];
      return (await verifySchulamt(schulamt(), fetchFollowing(api), bezirke)).map((p) => `Schulamt (config/schulamt.json): ${p} — сверь страницу ведомства и обнови снимок`);
    });
  } finally {
    await api.dispose();
  }
  // «keine Daten» текущего года vunt называют и KEY_FIGURES, и scoreProblems — одной строкой
  console.log(JSON.stringify({ ok: problems.length === 0, problems: [...new Set(problems)], summary: run && summarize(run) }, null, 2));
  if (problems.length) process.exitCode = 1;
}

/**
 * Снимки, устаревшие по календарю, — без сети, за секунду (SessionStart hook на каждом старте сессии; полный canary — раз в неделю):
 * заявка округа в инвестпрограмму, решение о зонах прошлого слоя, esbOverrides прошлого слоя. Всё в порядке — stdout пустой.
 */
async function staleCmd() {
  const problems = [...districtStale(district()).map((p) => `config/district.json: ${p}`), ...overridesStale()];
  if (problems.length) console.log(problems.map((p) => `- ${p}`).join('\n'));
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
  stale: staleCmd,
  preflight: preflightCmd,
  startchancen: startchancenCmd,
};
const cmd = commands[positionals[0]];
if (!cmd) {
  console.error(
    'Использование: tsx src/cli.ts resolve|lookup|plz|context|canary|stale|preflight|startchancen [--input f.json | --address "..." | --plz 10439 | --ortsteil Friedenau [--street "..."] | plz --input plz-input.json | --dir out/<адрес>] [--headed --slowmo N --trace]',
  );
  process.exit(2);
}
await cmd();
