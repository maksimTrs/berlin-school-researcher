import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContextSchema, Draft, findQuote, foreignNumbers, normalize, pageText, verifyDraft, type DraftItem, type Fetched } from '../../src/context.js';
import { schulamt } from '../../src/schulamt.js';
import { district, districtFacts, investmentCategory, investmentInWindow, investmentSummary, parseInvestment, PLAN_MAX_AGE_MONTHS, verifyDistrict, type District } from '../../src/district.js';

// реальные документы Bezirksamt Charlottenburg-Wilmersdorf: инвестплан (Beschluss 25.02.2025), решение о зонах (17.06.2025) и страницы решений
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
type Doc = District['documents'][number];
const INVEST = district().documents.find((d) => d.kind === 'investment')!;
const CATCHMENT = district().documents.find((d): d is Extract<Doc, { kind: 'catchment' }> => d.kind === 'catchment')!;
const FILES: Record<string, [string, string]> = {
  [INVEST.url]: ['district_investment_04.pdf', 'application/pdf'],
  [CATCHMENT.url]: ['district_catchment_04.pdf', 'application/pdf'],
  [INVEST.decision]: ['district_decision_04_250225.html', 'text/html; charset=utf-8'],
  [CATCHMENT.decision]: ['district_decision_04_250617.html', 'text/html; charset=utf-8'],
};
const fetchFixture = async (url: string): Promise<Fetched> => {
  const [file, contentType] = FILES[url] ?? [null, ''];
  return file ? { url, status: 200, contentType, body: fixture(file) } : { url, status: 404, contentType: 'text/html', body: Buffer.alloc(0) };
};

const NOW = new Date('2026-11-03T12:00:00Z'); // слой esb_2026
const FRESH = new Date('2026-03-02T12:00:00Z'); // заявке 25.02.2025 — 12 мес.: canary ещё не просит новую
const CW = 'Charlottenburg-Wilmersdorf';
const text = await pageText({ contentType: 'application/pdf', body: fixture('district_investment_04.pdf') });
const rows = parseInvestment(text);
const brief = (bsn: string) => rows.filter((r) => r.bsn === bsn).map((r) => [r.measure, r.status, r.endeBau, r.priority]);

describe('investment plan rows', () => {
  it('Gezielte and Pauschale rows of a school are found by BSN, with status, EndeBau and Dringlichkeitsliste priority', () => {
    expect(rows.filter((r) => r.zuweisung === 'Gezielte').length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.zuweisung === 'Pauschale').length).toBeGreaterThan(0);
    expect(brief('04G18')).toEqual([['Gesamtsanierung', 'Verschoben', 2027, null]]);
    expect(brief('04G20')).toEqual([['Gesamtsanierung', 'Begonnen', 2028, null], ['Erweiterungsbau', null, 2028, null]]);
    expect(brief('04G25')).toEqual([['Erweiterungsbau', null, 2028, 5], ['Gesamtsanierung', null, 2028, null]]);
    expect(brief('04G26')).toEqual([['Erweiterungsbau', null, 2028, null], ['Gesamtsanierung', 'Verschoben', 2030, null]]); // «Name; Erweiterungsbau;» — тоже
    expect(brief('04S07')).toEqual([['Gesamtsanierung', 'Begonnen', 2030, null]]); // Ergänzungsbau без EndeBau — без срока
    expect(brief('04G12')).toEqual([['Gesamtsanierung', 'Begonnen', 2026, null]]); // в плане «Eosander-Schinkel-Grundschule» — сопоставление по коду
  });

  it('a row wrapped onto the next text line is joined; its quote is verbatim in the document', () => {
    expect(brief('04G21')).toEqual([['Ergänzungsbau und Schließung der Baulücke für Schule und Kita', 'Begonnen', 2025, null]]);
    expect(brief('04G04')).toEqual([['Gesamtsanierung', 'Begonnen', 2027, null], ['Sanierung Sporthalle, Gesamtsanierung', null, 2024, null]]);
    const doc = normalize(text);
    expect(rows.filter((r) => !findQuote(doc, r.quote)).map((r) => r.bsn)).toEqual([]);
  });

  it('a row is shown until its EndeBau year has passed; cancelled (Wegfall) and beyond the construction window are not', () => {
    expect(investmentInWindow({ status: 'Begonnen', endeBau: 2026 }, NOW)).toBe(true);
    expect(investmentInWindow({ status: null, endeBau: 2025 }, NOW)).toBe(false);
    expect(investmentInWindow({ status: 'Wegfall', endeBau: 2029 }, NOW)).toBe(false);
    expect(investmentInWindow({ status: null, endeBau: 2032 }, NOW)).toBe(true); // окно стройки — до 2032-11
    expect(investmentInWindow({ status: null, endeBau: 2033 }, NOW)).toBe(false);
    // через 24 месяца после плана строки не пропадают: 2028 ещё впереди и в марте 2027
    expect(investmentInWindow({ status: 'Verschoben', endeBau: 2028 }, new Date('2027-03-15T12:00:00Z'))).toBe(true);
  });

  it('the one-liner names only fields of the row, numbers from the quote, at most 160 chars', () => {
    for (const r of rows) {
      const s = investmentSummary(r);
      expect(s.length).toBeLessThanOrEqual(160);
      expect(foreignNumbers(s, r.quote)).toEqual([]);
    }
    expect(investmentSummary(rows.find((r) => r.bsn === '04G25')!)).toBe(
      'Заявка округа в инвестпрограмму — Erweiterungsbau, окончание стройки по плану — 2028; приоритет 5 в Dringlichkeitsliste округа',
    );
  });
});

describe('district facts of a school', () => {
  const facts = districtFacts(fetchFixture);

  it('investment rows and the catchment decision for the school, the same on every run', async () => {
    const f = await facts({ bsn: '04G20', name: 'Katharina-Heinroth-Grundschule', bezirk: CW }, NOW);
    expect(f.rejected).toEqual([]);
    expect(f.items.map((i) => [i.category, i.planned, i.published, i.rule])).toEqual([
      ['construction', '2028', '2025-02-25', 'district'], // Gesamtsanierung — плановая стройка
      ['capacity', '2028', '2025-02-25', 'district'], // Erweiterungsbau — места
      ['capacity', null, '2025-06-17', 'district'],
    ]);
    expect(await facts({ bsn: '04G20', name: 'Katharina-Heinroth-Grundschule', bezirk: CW }, NOW)).toEqual(f);
  });

  it('Comenius-Schule: plan row and the decision quote about its Regelzüge', async () => {
    const f = await facts({ bsn: '04S07', name: 'Comenius-Schule', bezirk: CW }, NOW);
    expect(f.items.map((i) => i.category)).toEqual(['construction', 'catchment']);
    expect(f.items[1].quote).toContain('inklusive Schwerpunktschule mit 3 Regelzügen im Grundschulbereich');
  });

  it('a new zone layer drops the decision about the previous zones, the plan stays', async () => {
    const f = await facts({ bsn: '04G20', name: 'Katharina-Heinroth-Grundschule', bezirk: CW }, new Date('2027-08-01T12:00:00Z'));
    expect(f.items.map((i) => i.category)).toEqual(['construction', 'capacity']);
  });

  it('a document that does not load, or a snapshot quote gone from it, is a rejected line', async () => {
    const broken: District = {
      ...district(),
      documents: [
        { ...INVEST, url: 'https://www.berlin.de/ba-charlottenburg-wilmersdorf/gone.pdf' },
        { ...CATCHMENT, items: [{ bsn: ['04G23'], category: 'capacity', quote: 'Die Alt-Schmargendorf-Grundschule (04G23) hat freie Plätze in allen Klassen.', summaryRu: 'Свободные места' }] },
      ],
    };
    const f = await districtFacts(fetchFixture, broken)({ bsn: '04G23', name: 'Alt-Schmargendorf-Grundschule', bezirk: CW }, NOW);
    expect(f.items).toEqual([]);
    expect(f.rejected.map((r) => r.reason)).toEqual([
      'документ округа не загрузился: HTTP 404',
      'цитаты снимка config/district.json нет в документе — сверь снимок',
    ]);
  });

  it('verifyDraft: district facts join the report, the same document in the draft is rejected as a duplicate', async () => {
    const school = { bsn: '04G23', name: 'Alt-Schmargendorf-Grundschule', bezirk: CW };
    const draft = Draft.parse({
      bsn: '04G23',
      queries: ['Alt-Schmargendorf-Grundschule Sanierung'],
      items: [
        {
          category: 'construction',
          published: '2025-02',
          planned: '2029',
          url: `${INVEST.url.replace('https://www.', 'http://')}?ts=1745931341`, // тот же PDF по http, без www и с query
          quote: '04G23, Alt-Schmargendorf-Grundschule: Gesamtsanierung; 14199, Reichenhallerstr. 8-9 4.256 Verschoben 2029',
          summaryRu: 'Санация перенесена, 2029',
        },
      ],
    });
    const ctx = await verifyDraft(draft, school, { name: '', fields: [] }, fetchFixture, NOW, 5, await facts(school, NOW));
    expect(ctx.items.map((i) => [i.category, i.planned])).toEqual([
      ['capacity', null],
      ['construction', '2029'],
    ]);
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['документ округа из config/district.json: его строки по школе берёт код']);
  });
});

describe('district facts: corner cases', () => {
  const facts = districtFacts(fetchFixture);
  const item = (url: string, quote: string): DraftItem => ({ category: 'catchment', published: '2025-06', planned: null, url, quote, summaryRu: 'Зону школы расширили', contradicts: null });

  it('the catchment decision covers only schools quoted in the snapshot: a fact about another school of the document is checked as usual', async () => {
    // 04G17 есть в решении о зонах, но цитат о нём в снимке нет — запись Claude не повтор, её проверяют обычные правила
    const school = { bsn: '04G17', name: 'Johann-Peter-Hebel-Grundschule', bezirk: CW };
    const f = await facts(school, NOW);
    expect(f.urls).toEqual([INVEST.url]);
    const quote = 'wird der Einschulungsbereich der Johann-Peter-Hebel-Grundschule (04G17) erweitert';
    const ctx = await verifyDraft(Draft.parse({ bsn: '04G17', queries: ['q'], items: [item(CATCHMENT.url, quote)] }), school, { name: '', fields: [] }, fetchFixture, NOW, 5, f);
    expect(ctx.rejected.map((r) => r.reason)).not.toContain('документ округа из config/district.json: его строки по школе берёт код');
    // а у школы с цитатой в снимке тот же документ из черновика — повтор
    const g = await facts({ bsn: '04G20', name: 'Katharina-Heinroth-Grundschule', bezirk: CW }, NOW);
    expect(g.urls).toEqual([INVEST.url, CATCHMENT.url]);
  });

  it('every item the code builds passes the context.json schema (quote 30–600, one-liner ≤160): a broken file would cost the report its facts', async () => {
    for (const bsn of [...new Set(rows.map((r) => r.bsn))]) {
      const f = await facts({ bsn, name: bsn, bezirk: CW }, NOW);
      for (const i of f.items) expect(() => ContextSchema.shape.items.element.parse(i)).not.toThrow();
    }
  });

  it('district facts are outside the limits: a fresh construction note from Claude does not push a plan row out', async () => {
    const school = { bsn: '04G20', name: 'Katharina-Heinroth-Grundschule', bezirk: CW };
    const NEWS = 'https://www.berlin.de/ba-charlottenburg-wilmersdorf/aktuelles/pressemitteilungen/2026/pressemitteilung.1.php';
    const quote = 'An der Katharina-Heinroth-Grundschule beginnen im Dezember 2026 die Arbeiten am neuen Modulbau für vier Klassen.';
    const quote2 = 'Der Schulhof der Katharina-Heinroth-Grundschule bleibt während der Bauarbeiten teilweise gesperrt.';
    const fetch = async (url: string): Promise<Fetched> =>
      url === NEWS ? { url, status: 200, contentType: 'text/html', body: Buffer.from(`<main>Pressemitteilung vom 20.10.2026. ${quote} ${quote2}</main>`) } : fetchFixture(url);
    const news = { ...item(NEWS, quote), category: 'construction' as const, published: '2026-10-20', planned: '2026-12', summaryRu: 'В декабре начнут модульную пристройку' };
    // лимит — 1 факт: проходят все три факта округа и одна находка Claude, вторая — по лимиту
    const ctx = await verifyDraft(Draft.parse({ bsn: '04G20', queries: ['q'], items: [news, { ...news, quote: quote2, planned: null, summaryRu: 'Двор частично закрыт на время стройки' }] }), school, { name: '', fields: [] }, fetch, NOW, 1, await facts(school, NOW));
    expect(ctx.items.map((i) => [i.category, i.rule ?? 'claude'])).toEqual([
      ['construction', 'claude'],
      ['capacity', 'district'],
      ['capacity', 'district'], // одна дата документа — по важности темы: места раньше стройки
      ['construction', 'district'],
    ]);
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['лимит: не больше 1 фактов']);
  });

  it('a school of another district: documents are not even downloaded', async () => {
    const fetched: string[] = [];
    const f = await districtFacts(async (url) => (fetched.push(url), fetchFixture(url)))({ bsn: '01G01', name: 'Grundschule am Arkonaplatz', bezirk: 'Mitte' }, NOW);
    expect([f, fetched]).toEqual([{ items: [], rejected: [], urls: [] }, []]);
  });

  it('an extension is a fact about places, a renovation, gym or canteen is planned construction (wording of the plan)', () => {
    const kind = (measure: string) => investmentCategory({ measure });
    for (const m of ['Erweiterungsbau', 'Ergänzungsbau', 'Ergänzungsbauten für Schule und Hort', 'Schulplatzerweiterung', 'Ergänzungsbau für Regelzug', 'Aufstockung Anbau'])
      expect([m, kind(m)]).toEqual([m, 'capacity']);
    for (const m of ['Gesamtsanierung', 'Sanierung der Sporthalle', 'Mensa-Erweiterung', 'Austockung der Sporthalle', 'Umbau der Kita und Bau einer Mensa'])
      expect([m, kind(m)]).toEqual([m, 'construction']);
  });

  it('a long measure is shortened, the year and priority stay', () => {
    const r = { ...rows.find((x) => x.bsn === '04G25')!, measure: 'Erweiterungsbau '.repeat(12).trim() };
    const s = investmentSummary(r);
    expect(s.length).toBeLessThanOrEqual(160);
    expect(s).toContain('…, окончание стройки по плану — 2028; приоритет 5');
  });

  it('a page without plan rows parses to nothing', () => {
    expect(parseInvestment('Anmeldungen des Bezirks\n3701 70206 Gezielte Zuweisung Inv. Neubau ohne Schule 1.000 0 0')).toEqual([]);
  });
});

describe('district snapshot', () => {
  it('every document names a district as WFS spells it (a typo would silently switch the document off)', () => {
    expect(district().documents.filter((d) => !(d.bezirk in schulamt().bezirke)).map((d) => d.bezirk)).toEqual([]);
  });

  it('config/district.json parses, no summary adds a number its quote lacks', () => {
    for (const d of district().documents)
      if (d.kind === 'catchment') expect(d.items.filter((i) => foreignNumbers(i.summaryRu, i.quote).length)).toEqual([]);
  });

  it('canary: documents parse, quotes are in place, decision pages name the date and link the document', async () => {
    expect(await verifyDistrict(district(), fetchFixture, FRESH)).toEqual([]);
  });

  it('canary: a plan without parsable rows and a decision page without the link are named', async () => {
    const fetch = async (url: string): Promise<Fetched> =>
      url === INVEST.url
        ? { url, status: 200, contentType: 'text/html', body: Buffer.from('<main>Anmeldungen zum Investitionsprogramm</main>') }
        : url === INVEST.decision
          ? { url, status: 200, contentType: 'text/html', body: Buffer.from('<main><h1>BA-Beschlussprotokoll 25. Februar 2025</h1></main>') }
          : fetchFixture(url);
    expect(await verifyDistrict({ documents: [INVEST] }, fetch, FRESH)).toEqual([
      `${INVEST.url}: ни одной строки школы с EndeBau — сменилась вёрстка таблицы?`,
      `${INVEST.decision}: страница решения больше не ссылается на 150_ba_n_bproto_250225_anlage-1.pdf`,
    ]);
  });

  it('canary: a different decision date and a lost quote are named', async () => {
    const snap: District = {
      ...district(),
      documents: [{ ...INVEST, published: '2025-02-11' }, { ...CATCHMENT, items: [{ ...CATCHMENT.items[0], quote: 'Ein Satz, den es im Dokument nicht gibt, Versorgungsdefizit.' }] }],
    };
    expect(await verifyDistrict(snap, fetchFixture, FRESH)).toEqual([
      `${INVEST.decision}: первая дата на странице решения — не 2025-02-11`,
      `${CATCHMENT.url}: цитаты «Ein Satz, den es im Dokument nicht gibt, Versorgungsdefizit.…» больше нет в документе`,
    ]);
  });

  it('canary: a plan older than PLAN_MAX_AGE_MONTHS asks for the new one, unless checked says there is none yet', async () => {
    const stale = `${INVEST.url}: заявке в инвестпрограмму от 2025-02-25 больше ${PLAN_MAX_AGE_MONTHS} мес. — найди на сайте Bezirksamt новую (Anmeldungen zum Investitionsprogramm) и замени запись; новее нет — поставь checked: дату проверки`;
    expect(await verifyDistrict({ documents: [INVEST] }, fetchFixture, new Date('2026-05-02T12:00:00Z'))).toEqual([]); // 14 мес.
    expect(await verifyDistrict({ documents: [INVEST] }, fetchFixture, new Date('2026-06-02T12:00:00Z'))).toEqual([stale]); // 16 мес.
    expect(await verifyDistrict({ documents: [{ ...INVEST, checked: '2026-10-20' }] }, fetchFixture, NOW)).toEqual([]);
    expect(await verifyDistrict({ documents: [{ ...INVEST, checked: '2026-10-20' }] }, fetchFixture, new Date('2028-02-01T12:00:00Z'))).toEqual([stale]);
  });

  it('canary: a catchment decision for a past zone layer is named — reports stop showing it on 1 August', async () => {
    const past = `${CATCHMENT.url}: решение о зонах для esb_2026, а текущий слой — esb_2027; в отчёты оно больше не идёт — найди решение Bezirksamt о Zuschneidung der Einschulungsbereiche под новый слой или удали запись`;
    expect(await verifyDistrict({ documents: [CATCHMENT] }, fetchFixture, new Date('2027-07-31T12:00:00Z'))).toEqual([]);
    expect(await verifyDistrict({ documents: [CATCHMENT] }, fetchFixture, new Date('2027-08-01T12:00:00Z'))).toEqual([past]);
    // решение под следующий слой, принятое до августа, — ещё не действует, но и не устарело
    expect(await verifyDistrict({ documents: [CATCHMENT] }, fetchFixture, new Date('2026-03-02T12:00:00Z'))).toEqual([]);
  });

  it('a catchment decision for a past layer gives no facts any more', async () => {
    const facts = districtFacts(fetchFixture, { documents: [CATCHMENT] });
    expect((await facts({ bsn: '04G20', name: 'Katharina-Heinroth-Grundschule', bezirk: CW }, new Date('2027-08-01T12:00:00Z'))).items).toEqual([]);
  });
});
