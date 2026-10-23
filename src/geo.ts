import type { APIRequestContext } from 'playwright';
import { config } from './config.js';
import type { AddressQuery } from './schema.js';

const WFS = 'https://gdi.berlin.de/services/wfs/';

type Geometry = { type: string; coordinates: any };
type Feature = { id: string; geometry: Geometry; properties: Record<string, any> };

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
  return (await res.json()).features;
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

// «Bergmannstr.», «Ruppiner Strasse» → префикс для ILIKE, совпадает с «…straße» в реестре
const streetPrefix = (street: string) => street.trim().replace(/(straße|strasse|str\.?)$/i, 'str');

export async function geocode(api: APIRequestContext, q: AddressQuery): Promise<Candidate[]> {
  const conds = [`str_name ILIKE ${cqlString(streetPrefix(q.street) + '%')}`, `hnr=${q.house}`];
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
  const street = streetPrefix(q.street).toLowerCase();
  cands = preferSome(cands, (c) => streetPrefix(c.street).toLowerCase() === street);
  const suffix = q.suffix?.toLowerCase() ?? null;
  // запрошенной буквы дома нет в реестре — не подменяем молча соседним домом, пусть skill переспросит
  if (suffix && !cands.some((c) => c.suffix?.toLowerCase() === suffix)) return [];
  cands = preferSome(cands, (c) => (c.suffix?.toLowerCase() ?? null) === suffix);
  if (q.ortsteil) {
    const o = q.ortsteil.toLowerCase();
    cands = preferSome(cands, (c) => c.ortsteil.toLowerCase().includes(o) || c.bezirk.toLowerCase().includes(o));
  }
  return cands;
}

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

export type CatchmentStatus = 'exact' | 'override' | 'matched_by_code' | 'ambiguous' | 'no_school_in_zone' | 'no_zone';

export type Catchment = {
  esb: string | null;
  esbText: string | null;
  status: CatchmentStatus;
  schools: School[]; // первая — основная для полного блока
};

// ray casting по внешнему кольцу каждого полигона; точность для точки школы внутри района достаточна
function inGeometry([x, y]: [number, number], g: Geometry): boolean {
  const polygons: number[][][][] = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  return polygons.some(([ring]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}

/** Зона → школа: поправка > одна школа в зоне > совпадение кода зоны с bsn > все кандидаты; пустая зона → 3 ближайшие. */
export function assignSchool(
  esb: string,
  inside: School[],
  all: School[],
  from: { lon: number; lat: number },
  overrides: Record<string, string>,
): Pick<Catchment, 'status' | 'schools'> {
  const overridden = all.find((s) => s.bsn === overrides[esb]);
  if (overridden) return { status: 'override', schools: nearest([overridden], from, 1) };
  const sorted = nearest(inside, from, inside.length);
  if (sorted.length === 1) return { status: 'exact', schools: sorted };
  if (sorted.length > 1) {
    // часть районов нумерует зону по школе: зона 1105 ↔ школа 11G05
    const byCode = sorted.filter((s) => s.bsn.slice(0, 2) + s.bsn.slice(3) === esb);
    return byCode.length === 1 ? { status: 'matched_by_code', schools: byCode } : { status: 'ambiguous', schools: sorted };
  }
  return { status: 'no_school_in_zone', schools: nearest(all, from, 3) };
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
