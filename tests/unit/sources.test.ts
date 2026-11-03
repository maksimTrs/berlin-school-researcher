import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Draft, fetchFollowing, inspectionReport, onSchoolSite, verifyDraft, type DraftItem, type Fetched } from '../../src/context.js';

// реальный отчёт Schulinspektion (bildung.berlin.de, «veröffentlicht am 01.12.2025» на Schulporträt); сайт школы — заглушка
const INSPECTION = 'https://www.bildung.berlin.de/Schulverzeichnis/DokLoader.aspx?Schulinspektion=04G04_B_20251201_1082.pdf';
const SITE = 'http://www.joan-miro-grundschule.de';
const school = { bsn: '04G04', name: 'Joan-Miró-Grundschule', web: SITE };
const NOW = new Date('2026-11-03T12:00:00Z');
const page = (url: string, text: string): Fetched => ({ url, status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from(`<nav>Menü 2019</nav><main>${text}</main>`) });
const fetchFixture = async (url: string): Promise<Fetched> => {
  if (url === INSPECTION) return { url, status: 200, contentType: 'adobe/pdf', body: readFileSync(new URL('../fixtures/context_inspection_04G04.pdf', import.meta.url)) };
  if (url.startsWith('https://www.joan-miro-grundschule.de/profil/'))
    return page(url, 'Unser Profil. Wir sind eine Schule mit gebundenem Ganztag und bieten ab Klasse 1 Englisch und eine Theater-AG an.');
  if (url.startsWith('https://www.joan-miro-grundschule.de/aktuelles/preis'))
    return page(url, 'Meldung vom 12.03.2026. Unsere Schule hat den Berliner Preis für Leseförderung erhalten.');
  return { url, status: 404, contentType: 'text/html', body: Buffer.alloc(0) };
};
const item = (over: Partial<DraftItem>): DraftItem => ({
  category: 'concerns',
  published: '2025-12-01',
  planned: null,
  url: INSPECTION,
  quote: 'Unterrichtsgestaltung, die die heterogenen Voraussetzungen der Lernenden stärker berücksichtigt',
  summaryRu: 'Инспекция: уроки мало учитывают разный уровень учеников',
  contradicts: null,
  ...over,
});
const verify = (items: DraftItem[], s: typeof school = school) =>
  verifyDraft(Draft.parse({ bsn: s.bsn, queries: ['q'], items }), s, { name: '', fields: [] }, fetchFixture, NOW);
const reasons = async (items: DraftItem[], s?: typeof school) => (await verify(items, s)).rejected.map((r) => r.reason);

describe('Schulinspektion report on bildung.berlin.de', () => {
  it('school and publication date come from the file name', () => {
    expect(inspectionReport(INSPECTION)).toEqual({ bsn: '04G04', published: '2025-12-01' });
    expect(inspectionReport('https://www.bildung.berlin.de/Schulverzeichnis/schulportrait.aspx?IDSchulzweig=1')).toBeNull();
    expect(inspectionReport('https://evil.example/Schulverzeichnis/DokLoader.aspx?Schulinspektion=04G04_B_20251201_1082.pdf')).toBeNull();
  });

  it('a need for development and a strength from the report are facts, though the PDF header has no date and spells «Joan-Miro»', async () => {
    const ctx = await verify([
      item({}),
      item({
        category: 'strengths',
        quote: 'strukturiertes und auf die kontinuierliche Weiterentwicklung der Schule ausgerichtetes Schulleitungshandeln',
        summaryRu: 'Инспекция: сильная сторона — руководство школы, нацеленное на развитие',
      }),
    ]);
    expect(ctx.rejected).toEqual([]);
    expect(ctx.items.map((i) => [i.category, i.host, i.source])).toEqual([
      ['concerns', 'www.bildung.berlin.de', 'official'],
      ['strengths', 'www.bildung.berlin.de', 'official'],
    ]);
  });

  it('a report of another school, a wrong date, an old report are rejected', async () => {
    expect(await reasons([item({})], { ...school, bsn: '04G12', name: 'Schinkel-Grundschule' })).toEqual(['отчёт Schulinspektion другой школы (04G04)']);
    expect(await reasons([item({ published: '2025-12' })])).toEqual(['отчёт Schulinspektion опубликован 2025-12-01 (имя файла), а не 2025-12']);
    const old = 'https://www.bildung.berlin.de/Schulverzeichnis/DokLoader.aspx?Schulinspektion=04G04_B_20150701_391.pdf';
    expect(await reasons([item({ url: old, published: '2015-07-01' })])).toEqual(['старше 12 мес. и не план на ближайшие 6 мес.']);
  });
});

describe('the school’s own website', () => {
  it('only the domain from Schulverzeichnis, with or without www', () => {
    expect(onSchoolSite('https://joan-miro-grundschule.de/profil/', SITE)).toBe(true);
    expect(onSchoolSite('https://joan-miro-grundschule.de.evil.example/', SITE)).toBe(false);
    expect(onSchoolSite('https://www.joan-miro-grundschule.de/', null)).toBe(false);
  });

  it('strengths from an undated page: «со слов школы», published is the month of the check', async () => {
    const strength = item({
      category: 'strengths',
      url: 'https://www.joan-miro-grundschule.de/profil/',
      published: '2026-11',
      quote: 'Wir sind eine Schule mit gebundenem Ganztag und bieten ab Klasse 1 Englisch',
      summaryRu: 'Со слов школы: gebundener Ganztag и английский с 1 класса',
    });
    const ctx = await verify([strength]);
    expect(ctx.items.map((i) => i.source)).toEqual(['school']);
    expect(await reasons([{ ...strength, published: '2026-09' }])).toEqual(['у страницы сайта школы нет даты — published должен быть месяцем проверки 2026-11']);
  });

  it('a dated page keeps the usual date check; other topics, the home page and another school’s site are rejected', async () => {
    const award = item({
      category: 'strengths',
      url: 'https://www.joan-miro-grundschule.de/aktuelles/preis.html',
      published: '2026-03-12',
      quote: 'Unsere Schule hat den Berliner Preis für Leseförderung erhalten.',
      summaryRu: 'Со слов школы: Berliner Preis für Leseförderung',
    });
    expect((await verify([award])).items).toHaveLength(1);
    expect(await reasons([{ ...award, published: '2026-03-01' }])).toEqual(['первая дата в шапке документа — не 2026-03-01']);
    expect(await reasons([{ ...award, category: 'concerns' }])).toEqual([
      'www.joan-miro-grundschule.de/aktuelles/preis.html: не в списке официальных источников (config.context); сайт школы — только для темы strengths',
    ]);
    expect(await reasons([{ ...award, url: 'https://www.joan-miro-grundschule.de/' }])).toEqual(['страница-список, а не документ: нужна ссылка на саму заметку']);
    expect(await reasons([award], { ...school, web: 'http://www.andere-schule.de' })).toEqual([
      'www.joan-miro-grundschule.de/aktuelles/preis.html: не в списке официальных источников (config.context)',
    ]);
  });

  it('redirects stay on the allowed school sites only', async () => {
    const api = {
      get: async (url: string) => {
        const to = url.startsWith('http://www.joan-miro') ? 'https://www.joan-miro-grundschule.de/profil/' : url.includes('profil') ? 'https://tracker.example/x' : null;
        return { status: () => (to ? 301 : 200), headers: () => (to ? { location: to } : { 'content-type': 'text/html' }), body: async () => Buffer.from('<main>ok</main>') };
      },
    };
    const allow = (url: string) => onSchoolSite(url, SITE);
    const f = await fetchFollowing(api as never, allow)('http://www.joan-miro-grundschule.de/profil/');
    expect([f.url, f.body.length]).toEqual(['https://tracker.example/x', 0]); // школа → чужой сайт: дальше не идём, verifyDraft отклонит
  });
});
