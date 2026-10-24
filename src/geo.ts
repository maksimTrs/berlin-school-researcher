import type { APIRequestContext } from 'playwright';
import { config } from './config.js';
import type { AddressQuery, PlzQuery } from './schema.js';

const WFS = 'https://gdi.berlin.de/services/wfs/';

export type Geometry = { type: string; coordinates: any };
export type Feature = { id: string; geometry: Geometry; properties: Record<string, any> };

async function getFeatures(
  api: APIRequestContext,
  service: string,
  typeName: string,
  cql: string,
  srsName: 'EPSG:25833' | 'EPSG:4326',
): Promise<Feature[]> {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    outputFormat: 'application/json',
    typeNames: `${service}:${typeName}`,
    srsName,
    CQL_FILTER: cql,
  });
  const res = await api.get(`${WFS}${service}?${params}`, { maxRetries: 2 });
  if (!res.ok()) throw new Error(`WFS ${service}: HTTP ${res.status()} ${await res.text()}`);
  const { features, numberMatched } = await res.json();
  // сервер отдаёт не больше CountDefault (сейчас 1 000 000): урезанная выдача молча исказила бы доли зон PLZ
  if (typeof numberMatched === 'number' && features.length < numberMatched)
    throw new Error(`WFS ${service}: отдано ${features.length} из ${numberMatched} объектов`);
  return features;
}

const cqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---------- адрес ----------

export type Candidate = {
  street: string;
  house: number;
  suffix: string | null;
  plz: string;
  ortsteil: string;
  bezirk: string;
  x25833: number;
  y25833: number;
  lon: number;
  lat: number;
};

export const formatAddress = (c: Candidate) => `${c.street} ${c.house}${c.suffix ?? ''}, ${c.plz} ${c.ortsteil}`;

// ß/ss и умлауты/ae-oe-ue пишут как угодно — сравниваем после свёртки
const fold = (s: string) =>
  s.trim().toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue');

/** «Bergmannstr.», «Ruppiner Strasse», «Ruppiner Straße» → «bergmannstr», «ruppiner str» */
export const normStreet = (street: string) => fold(street).replace(/(strasse|str\.?)$/, 'str');

/** ILIKE-шаблон: ss/ae/oe/ue → «%», чтобы «Grossbeerenstr» нашла «Großbeerenstraße»; лишнее отсеет normStreet */
export const streetPattern = (street: string) => normStreet(street).replace(/ss|ae|oe|ue/g, '%') + '%';

/**
 * Хвост адреса из объявления → признак района: «Berlin, Halensee (Wilmersdorf)», «Prenzlauer Berg (Prenzlauer Berg)»,
 * «Berlin - Moabit». В скобках ImmoScout пишет старый (до 2001) округ — он тоже часть названия района или Ortsteil.
 */
export const inArea = (ortsteilQuery: string, c: Pick<Candidate, 'ortsteil' | 'bezirk'>) => {
  const area = fold(`${c.ortsteil} ${c.bezirk}`);
  return fold(ortsteilQuery)
    .split(/[,()/–-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 3 && t !== 'berlin')
    .some((t) => area.includes(t));
};

export async function geocode(api: APIRequestContext, q: AddressQuery): Promise<Candidate[]> {
  const conds = [`str_name ILIKE ${cqlString(streetPattern(q.street))}`, `hnr=${q.house}`];
  if (q.plz) conds.push(`plz=${cqlString(q.plz)}`);
  const cql = conds.join(' AND ');
  // CQL-фильтры других слоёв принимают точку в родной EPSG:25833, а ссылкам Google Maps нужны lon/lat
  const [utm, wgs] = await Promise.all([
    getFeatures(api, 'adressen_berlin', 'adressen_berlin', cql, 'EPSG:25833'),
    getFeatures(api, 'adressen_berlin', 'adressen_berlin', cql, 'EPSG:4326'),
  ]);
  const lonLat = new Map(wgs.map((f) => [f.id, f.geometry.coordinates as [number, number]]));
  let cands: Candidate[] = utm.map((f) => {
    const p = f.properties;
    const [lon, lat] = lonLat.get(f.id)!;
    return {
      street: p.str_name,
      house: p.hnr,
      suffix: p.hnr_zusatz ?? null,
      plz: p.plz,
      ortsteil: p.ort_name,
      bezirk: p.bez_name,
      x25833: f.geometry.coordinates[0],
      y25833: f.geometry.coordinates[1],
      lon,
      lat,
    };
  });

  // ILIKE по префиксу ловит и «Am Waldidyll» для «Am Wald» — точное совпадение имени важнее
  const street = normStreet(q.street);
  cands = preferSome(cands, (c) => normStreet(c.street) === street);
  const suffix = q.suffix?.toLowerCase() ?? null;
  // запрошенной буквы дома нет в реестре — не подменяем молча соседним домом, пусть skill переспросит
  if (suffix && !cands.some((c) => c.suffix?.toLowerCase() === suffix)) return [];
  cands = preferSome(cands, (c) => (c.suffix?.toLowerCase() ?? null) === suffix);
  if (q.ortsteil) cands = preferSome(cands, (c) => inArea(q.ortsteil!, c));
  return cands;
}

/** Кандидаты на самой запрошенной улице: geocode оставляет и «Am Waldidyll» на «Am Wald», если точной нет. */
export const onStreet = (q: AddressQuery, cands: Candidate[]) => cands.filter((c) => normStreet(c.street) === normStreet(q.street));

// единственный кандидат с другой улицей — не exact, пусть skill переспросит
export const resolveStatus = (q: AddressQuery, cands: Candidate[]) =>
  cands.length === 1 && onStreet(q, cands).length ? 'exact' : cands.length ? 'ambiguous' : 'none';

// сужаем, только если сужение что-то оставляет — иначе показываем всех кандидатов
const preferSome = <T>(xs: T[], pred: (x: T) => boolean) => (xs.some(pred) ? xs.filter(pred) : xs);

// ---------- школы ----------

export type School = {
  bsn: string;
  name: string;
  schulart: string;
  address: string;
  ortsteil: string;
  bezirk: string;
  phone: string | null;
  email: string | null;
  web: string | null;
  lon: number;
  lat: number;
  distanceM?: number;
};

let primarySchoolsCache: School[] | undefined;

export async function primarySchools(api: APIRequestContext): Promise<School[]> {
  primarySchoolsCache ??= (
    await getFeatures(
      api,
      'schulen',
      'schulen',
      "traeger='oeffentlich' AND schulart IN ('Grundschule','Gemeinschaftsschule')",
      'EPSG:4326',
    )
  ).map((f) => {
    const p = f.properties;
    return {
      bsn: p.bsn,
      name: p.schulname,
      schulart: p.schulart,
      address: `${p.strasse} ${p.hausnr}, ${p.plz} Berlin`,
      ortsteil: p.ortsteil,
      bezirk: p.bezirk,
      phone: p.telefon ?? null,
      email: p.email ?? null,
      web: p.internet ?? null,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    };
  });
  return primarySchoolsCache;
}

export function distanceM(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}

export function nearest(schools: School[], from: { lon: number; lat: number }, n: number): School[] {
  return schools
    .map((s) => ({ ...s, distanceM: distanceM(from, s) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, n);
}

// ---------- зона → школа ----------

export type CatchmentStatus = 'exact' | 'override' | 'joint' | 'matched_by_code' | 'ambiguous' | 'no_school_in_zone' | 'no_zone';

export type Catchment = {
  esb: string | null;
  esbText: string | null;
  status: CatchmentStatus;
  schools: School[]; // первая — основная для полного блока
};

// ray casting: точка во внешнем кольце полигона и ни в одной его дыре (анклав другой зоны)
function inGeometry(p: [number, number], g: Geometry): boolean {
  const polygons: number[][][][] = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  return polygons.some(([outer, ...holes]) => inRing(p, outer) && !holes.some((h) => inRing(p, h)));
}

function inRing([x, y]: [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Зона → школа: поправка > одна школа в зоне > совпадение кода зоны с bsn > все кандидаты; пустая зона → 3 ближайшие.
 * Поправка списком — общая зона нескольких школ (gemeinsamer ESB в справочнике округа): закреплены все, ближайшая первой.
 */
export function assignSchool(
  esb: string,
  inside: School[],
  all: School[],
  from: { lon: number; lat: number },
  overrides: Record<string, string | string[]>,
): Pick<Catchment, 'status' | 'schools'> {
  const listed = [overrides[esb] ?? []].flat();
  const overridden = all.filter((s) => listed.includes(s.bsn));
  // школа поправки пропала из реестра — поправка устарела, решают пространственные правила
  if (listed.length && overridden.length === listed.length)
    return { status: listed.length > 1 ? 'joint' : 'override', schools: nearest(overridden, from, overridden.length) };
  const sorted = nearest(inside, from, inside.length);
  if (sorted.length === 1) return { status: 'exact', schools: sorted };
  if (sorted.length > 1) {
    // часть районов нумерует зону по школе: зона 1105 ↔ школа 11G05
    const byCode = sorted.filter((s) => s.bsn.slice(0, 2) + s.bsn.slice(3) === esb);
    // остальные школы зоны остаются в отчёте кандидатами
    return byCode.length === 1
      ? { status: 'matched_by_code', schools: [byCode[0], ...sorted.filter((s) => s !== byCode[0])] }
      : { status: 'ambiguous', schools: sorted };
  }
  return { status: 'no_school_in_zone', schools: nearest(all, from, 3) };
}

/** Поправка esbOverrides для зоны есть, но не применилась (школы нет в реестре) — строка для warnings, иначе null. */
export function overrideIgnored(c: Pick<Catchment, 'esb' | 'status'>, overrides = config.esbOverrides): string | null {
  const listed = c.esb ? overrides[c.esb] : undefined;
  if (!listed || c.status === 'override' || c.status === 'joint') return null;
  return `Поправка esbOverrides для зоны ${c.esb} (${[listed].flat().join(', ')}) не применена: школы нет в реестре — школа выбрана по карте, поправку сверить`;
}

/** Для canary: каждый код зоны из esbOverrides есть в слое esbLayer, каждая школа — в реестре. Пустой список — всё на месте. */
export async function checkOverrides(api: APIRequestContext, overrides = config.esbOverrides): Promise<string[]> {
  const known = new Set((await primarySchools(api)).map((s) => s.bsn));
  const problems: string[] = [];
  for (const [esb, listed] of Object.entries(overrides)) {
    if (!(await getFeatures(api, 'esb', config.esbLayer, `esb=${cqlString(esb)}`, 'EPSG:4326')).length)
      problems.push(`esbOverrides: зоны ${esb} нет в слое ${config.esbLayer} — поправку сверить со справочником округа`);
    for (const bsn of [listed].flat())
      if (!known.has(bsn)) problems.push(`esbOverrides: школы ${bsn} (зона ${esb}) нет в реестре schulen — поправка не применяется`);
  }
  return problems;
}

export async function catchment(api: APIRequestContext, addr: Candidate): Promise<Catchment> {
  const [zone] = await getFeatures(
    api,
    'esb',
    config.esbLayer,
    `INTERSECTS(geom,POINT(${addr.x25833} ${addr.y25833}))`,
    'EPSG:4326',
  );
  const all = await primarySchools(api);
  if (!zone) return { esb: null, esbText: null, status: 'no_zone', schools: nearest(all, addr, 3) };
  const inside = all.filter((s) => inGeometry([s.lon, s.lat], zone.geometry));
  return {
    esb: zone.properties.esb,
    esbText: zone.properties.esb_text ?? null,
    ...assignSchool(zone.properties.esb, inside, all, addr, config.esbOverrides),
  };
}

export async function neighbors(api: APIRequestContext, addr: Candidate, exclude: School[], n: number): Promise<School[]> {
  const skip = new Set(exclude.map((s) => s.bsn));
  return nearest((await primarySchools(api)).filter((s) => !skip.has(s.bsn)), addr, n);
}

// ---------- PLZ → зоны ----------

export type PlzAddress = { street: string; house: number; suffix: string | null; plz?: string; lon: number; lat: number };

/**
 * Зона внутри PLZ или района: школа по тем же правилам, что для адреса, дома запроса, которые в неё попали,
 * и сколько из них в каждом PLZ — объявление называет PLZ, а район делят несколько индексов.
 */
export type ZoneShare = Catchment & {
  addresses: number;
  plzs: { plz: string; addresses: number }[];
  streets: { street: string; houses: string[] }[];
  // для карты в отчёте; в result.json до карты их нет
  geometry?: Geometry; // граница зоны, координаты округлены до ~10 м
  points?: [number, number][]; // дома запроса в этой зоне, [lon, lat]
};

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/** Граница для карты: координаты до 4 знаков (~10 м), подряд совпавшие точки — одна. */
export function compactGeometry(g: Geometry): Geometry {
  const ring = (r: number[][]) =>
    r.map(([x, y]) => [round(x, 4), round(y, 4)]).filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  if (g.type === 'Polygon') return { type: g.type, coordinates: g.coordinates.map(ring) };
  if (g.type === 'MultiPolygon') return { type: g.type, coordinates: g.coordinates.map((p: number[][][]) => p.map(ring)) };
  return g;
}

/** Адреса → зоны, в которые они попадают, от большей группы к меньшей. Адрес вне всех зон не попадает никуда. */
export function groupByZone(addrs: PlzAddress[], zones: Feature[]): { zone: Feature; addrs: PlzAddress[] }[] {
  const groups = new Map<Feature, PlzAddress[]>();
  for (const a of addrs) {
    const zone = zones.find((z) => inGeometry([a.lon, a.lat], z.geometry));
    if (zone) (groups.get(zone) ?? groups.set(zone, []).get(zone)!).push(a);
  }
  return [...groups].map(([zone, addrs]) => ({ zone, addrs })).sort((a, b) => b.addrs.length - a.addrs.length);
}

/** Номера домов по улицам, по возрастанию: «Schivelbeiner Straße» → ['1', '2', '3A', …]. */
export function streetsOf(addrs: PlzAddress[]): ZoneShare['streets'] {
  const sorted = [...addrs].sort(
    (a, b) => a.street.localeCompare(b.street, 'de') || a.house - b.house || (a.suffix ?? '').localeCompare(b.suffix ?? ''),
  );
  const byStreet = new Map<string, string[]>();
  for (const a of sorted) (byStreet.get(a.street) ?? byStreet.set(a.street, []).get(a.street)!).push(`${a.house}${a.suffix ?? ''}`);
  return [...byStreet].map(([street, houses]) => ({ street, houses }));
}

/** Число адресов по PLZ, от большего к меньшему. */
export function plzsOf(addrs: PlzAddress[]): ZoneShare['plzs'] {
  const n = new Map<string, number>();
  for (const a of addrs) if (a.plz) n.set(a.plz, (n.get(a.plz) ?? 0) + 1);
  return [...n].map(([plz, addresses]) => ({ plz, addresses })).sort((a, b) => b.addresses - a.addresses || a.plz.localeCompare(b.plz));
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** «Schöneberg», «Schoeneberg», «schöneberg» → один и тот же район: ILIKE-шаблон, точное совпадение — после свёртки. */
const ortsteilPattern = (o: string) => fold(o).replace(/[%_]/g, '').replace(/ss|ae|oe|ue/g, '%');

/** Все адреса PLZ и/или района (или одной улицы в них) → зоны Einschulbereich, в которые они попадают, и школа каждой зоны. */
export async function plzZones(api: APIRequestContext, q: PlzQuery): Promise<{ total: number; zones: ZoneShare[] }> {
  const conds: string[] = [];
  if (q.plz) conds.push(`plz=${cqlString(q.plz)}`);
  if (q.ortsteil) conds.push(`ort_name ILIKE ${cqlString(ortsteilPattern(q.ortsteil))}`);
  if (q.street) conds.push(`str_name ILIKE ${cqlString(streetPattern(q.street))}`);
  let addrs: (PlzAddress & { ortsteil: string })[] = (
    await getFeatures(api, 'adressen_berlin', 'adressen_berlin', conds.join(' AND '), 'EPSG:4326')
  ).map((f) => ({
    street: f.properties.str_name,
    house: f.properties.hnr,
    suffix: f.properties.hnr_zusatz ?? null,
    plz: f.properties.plz,
    ortsteil: f.properties.ort_name ?? '',
    lon: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));
  // шаблон с «%» вместо ss/ae/oe/ue шире имени — оставляем только точное совпадение после свёртки
  if (q.ortsteil) addrs = addrs.filter((a) => fold(a.ortsteil) === fold(q.ortsteil!));
  if (q.street) {
    // ILIKE по префиксу ловит и «Am Waldidyll» для «Am Wald»: чужую улицу не выдаём за запрошенную — лучше not_found
    const street = normStreet(q.street);
    addrs = addrs.filter((a) => normStreet(a.street) === street);
  }
  if (!addrs.length) return { total: 0, zones: [] };

  // BBOX по адресам отдаёт и соседние зоны — лишние отсеет groupByZone
  const lons = addrs.map((a) => a.lon);
  const lats = addrs.map((a) => a.lat);
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].join(',');
  const zones = await getFeatures(api, 'esb', config.esbLayer, `BBOX(geom,${bbox},'EPSG:4326')`, 'EPSG:4326');
  const all = await primarySchools(api);
  return {
    total: addrs.length,
    zones: groupByZone(addrs, zones).map(({ zone, addrs }) => ({
      esb: zone.properties.esb,
      esbText: zone.properties.esb_text ?? null,
      // «ближайшие» для зоны без школы — к центру её адресов в этом PLZ
      ...assignSchool(
        zone.properties.esb,
        all.filter((s) => inGeometry([s.lon, s.lat], zone.geometry)),
        all,
        { lon: mean(addrs.map((a) => a.lon)), lat: mean(addrs.map((a) => a.lat)) },
        config.esbOverrides,
      ),
      addresses: addrs.length,
      plzs: plzsOf(addrs),
      streets: streetsOf(addrs),
      geometry: compactGeometry(zone.geometry),
      points: addrs.map((a): [number, number] => [round(a.lon, 5), round(a.lat, 5)]),
    })),
  };
}
