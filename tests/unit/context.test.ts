import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { APIRequestContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  ContextSchema,
  Draft,
  PlzContextSchema,
  PlzDraft,
  fetchFollowing,
  findQuote,
  foreignNumbers,
  inQuestion,
  isDocumentDate,
  mentionsSchool,
  normalize,
  outOfWindow,
  pageText,
  readContext,
  schoolKeys,
  sourceKind,
  verifyDraft,
  type DraftItem,
  type Fetched,
} from '../../src/context.js';
import type { Profile } from '../../src/extract.js';
import type { Catchment, School } from '../../src/geo.js';
import { renderPlzReport, renderReport, type AddressResult, type PlzResult } from '../../src/report.js';

// реальные источники: пресс-релиз округа (berlin.de), ответ Bezirksamt на запрос в BVV (копия на сайте фракции), ответ Senat в Abgeordnetenhaus (context_pardok_07G32.pdf)
const PRESS_URL = 'https://www.berlin.de/ba-treptow-koepenick/aktuelles/pressemitteilungen/2026/pressemitteilung.1687371.php';
const ANSWER_URL = 'https://gruene-fraktion-ts.de/wp-content/uploads/2026/02/Antwort-auf-die-MA-2_Zander-Rade_Struktureller-Raummangel-an-Schulen_final.pdf';
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
const PAGES: Record<string, Fetched> = {
  [PRESS_URL]: { url: PRESS_URL, status: 200, contentType: 'text/html; charset=UTF-8', body: fixture('context_press_09G06.html') },
  [ANSWER_URL]: { url: ANSWER_URL, status: 200, contentType: 'application/pdf', body: fixture('context_answer_07G32.pdf') },
};
const fetchFixture = async (url: string): Promise<Fetched> => {
  const f = PAGES[url];
  if (!f) throw new Error('getaddrinfo ENOTFOUND');
  return f;
};

const NOW = new Date('2026-10-23T12:00:00Z');
const MELLI = { bsn: '09G06', name: 'Melli-Beese-Schule (Grundschule)' };
const BUERGEL = { bsn: '07G32', name: 'Bruno-H.-Bürgel-Grundschule' };
const OFFERS = 'Предложения (Ganztag, профиль)';
const profile: Profile = { name: 'Bruno-H.-Bürgel-Grundschule - 07G32', fields: [[OFFERS, 'Lerngruppen für Neuzugänge ohne Deutschkenntnisse']] };

const item = (over: Partial<DraftItem>): DraftItem => ({
  category: 'construction',
  published: '2026-06-29',
  planned: null,
  url: PRESS_URL,
  quote: 'Die Fertigstellung des Erweiterungsbaus ist für Mitte 2027 geplant.',
  summaryRu: 'Пристройку планируют закончить в середине 2027',
  contradicts: null,
  ...over,
});
const draft = (bsn: string, items: DraftItem[]) => Draft.parse({ bsn, queries: ['test'], items });

/** Одностраничный PDF с одной строкой текста (без xref — pdf.js его восстанавливает). */
const pdf = (text: string) => {
  const stream = `BT /F1 10 Tf 20 700 Td (${text}) Tj ET`;
  return Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj',
      '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj',
      '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 2000 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj',
      `4 0 obj <</Length ${stream.length}>> stream\n${stream}\nendstream endobj`,
      '5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj',
      'trailer <</Root 1 0 R>>',
      '%%EOF',
    ].join('\n'),
    'latin1',
  );
};

describe('normalize / findQuote', () => {
  it('PDF line-break hyphenation, quotes and dashes match the typed quote', () => {
    expect(normalize('Auswir-\nkungen in Tempelhof-\nSchöneberg „Raum“ – frei')).toBe('auswirkungen in tempelhof-schöneberg "raum" - frei');
  });

  it('parts around «…» must come in order', async () => {
    const text = normalize(await pageText(PAGES[PRESS_URL]));
    expect(findQuote(text, 'Weil in den kommenden Jahren … wird die Melli-Beese-Schule zu einer 3,5-zügigen Grundschule ausgebaut.')).not.toBeNull();
    expect(findQuote(text, 'wird die Melli-Beese-Schule zu einer 3,5-zügigen Grundschule ausgebaut … Weil in den kommenden Jahren')).toBeNull();
    expect(findQuote(text, 'wird die Melli-Beese-Schule zu einer 4-zügigen Grundschule ausgebaut.')).toBeNull();
    expect(findQuote(text, 'kurz … zu kurze Teile')).toBeNull();
    // «…» не склеивает фразы из разных абзацев: так можно перевернуть смысл
    expect(findQuote(text, 'Weil in den kommenden Jahren … Insgesamt sollen alle Arbeiten bis 2029 abgeschlossen sein.')).toBeNull();
  });

  it('pageText reads the PDF answer', async () => {
    const text = normalize(await pageText(PAGES[ANSWER_URL]));
    expect(text).toContain('50. sitzung der bezirksverordnetenversammlung tempelhof-schöneberg von berlin am 18.02.2026');
  });
});

describe('checks', () => {
  it('schoolKeys: BSN and the name without «Grundschule»/«Schule»', () => {
    expect(schoolKeys(MELLI)).toEqual(['09g06', 'melli-beese']);
    expect(schoolKeys(BUERGEL)).toEqual(['07g32', 'bruno-h.-bürgel']);
    expect(schoolKeys({ bsn: '07G10', name: 'Schule am Ginkobaum (Grundschule)' })).toEqual(['07g10', 'am ginkobaum']);
    expect(schoolKeys({ bsn: '09G34', name: '34. Schule' })).toEqual(['09g34', '34. schule']);
    // одно слово слишком общее — полное имя
    expect(schoolKeys({ bsn: '07G01', name: 'Schöneberger Grundschule' })).toEqual(['07g01', 'schöneberger grundschule']);
  });

  it('mentionsSchool: whole word, not a school of another type', () => {
    const at = (text: string) => ({ start: 0, end: text.length });
    const has = (text: string, name: string) => mentionsSchool(normalize(text), at(text), schoolKeys({ bsn: '01G99', name }));
    expect(has('Die Grundschule am Schlosspark bekommt Container.', 'Grundschule am Schloss')).toBe(false);
    expect(has('An der Kurt-Tucholsky-Oberschule fehlen Räume.', 'Kurt-Tucholsky-Grundschule')).toBe(false);
    expect(has('An der Kurt-Tucholsky-Schule fehlen Räume.', 'Kurt-Tucholsky-Grundschule')).toBe(true);
    expect(has('Bezirk Tempelhof-Schöneberger Schulen: Raummangel.', 'Schöneberger Grundschule')).toBe(false);
  });

  it('mentionsSchool: the name without «Grundschule» counts only next to the word «Schule»', () => {
    const at = (text: string) => ({ start: 0, end: text.length });
    const has = (text: string, name: string) => mentionsSchool(normalize(text), at(text), schoolKeys({ bsn: '01G99', name }));
    // улица, площадь, другое учреждение с тем же именем — не школа
    expect(has('Die Grundschule an der Bäke in der Kurt-Tucholsky-Straße wird um 2 Züge erweitert.', 'Kurt-Tucholsky-Grundschule')).toBe(false);
    expect(has('In der Kurt-Tucholsky-Bibliothek fehlen Räume.', 'Kurt-Tucholsky-Grundschule')).toBe(false);
    expect(has('Der Spielplatz am Arkonaplatz wird ab Oktober 2026 gesperrt.', 'Grundschule am Arkonaplatz')).toBe(false);
    expect(has('Die Kita am Arkonaplatz bekommt einen Neubau.', 'Grundschule am Arkonaplatz')).toBe(false);
    expect(has('Das Gymnasium am Arkonaplatz bekommt einen Neubau.', 'Grundschule am Arkonaplatz')).toBe(false);
    // сама школа — в обоих порядках слов; «schule» внутри имени («Schulenburg») — не слово «Schule»
    expect(has('Die Kurt-Tucholsky-Grundschule bekommt Container.', 'Kurt-Tucholsky-Grundschule')).toBe(true);
    expect(has('Die Schule am Arkonaplatz bekommt Container.', 'Grundschule am Arkonaplatz')).toBe(true);
    expect(has('Die Graf-von-der-Schulenburg-Schule bekommt Container.', 'Graf-von-der-Schulenburg-Grundschule')).toBe(true);
    expect(has('In der Graf-von-der-Schulenburg-Straße wird gebaut.', 'Graf-von-der-Schulenburg-Grundschule')).toBe(false);
  });

  it('mentionsSchool: the school named before the quote counts only within 1500 chars', () => {
    const quote = 'die arbeiten dauern noch an.';
    const near = (filler: number) => {
      const text = normalize(`Die Melli-Beese-Schule wird erweitert. ${'wort '.repeat(filler)}${quote}`);
      const start = text.indexOf(quote);
      return mentionsSchool(text, { start, end: start + quote.length }, schoolKeys(MELLI));
    };
    expect(near(10)).toBe(true);
    expect(near(320)).toBe(false); // 1600 знаков между школой и цитатой
  });

  it('isDocumentDate: the first date in the header, day and month precision', () => {
    const text = normalize('Pressemitteilung vom 29.06.2026 · am 18. Februar 2026 · März 2025');
    expect(isDocumentDate(text, '2026-06-29')).toBe(true);
    expect(isDocumentDate(text, '2026-06')).toBe(true);
    expect(isDocumentDate(text, '2026-06-28')).toBe(false);
    expect(isDocumentDate(text, '2026-07')).toBe(false);
    // дата дальше в шапке — не дата документа: план 2026 года в пресс-релизе 2024 года не становится свежим фактом
    expect(isDocumentDate(text, '2026-02-18')).toBe(false);
    expect(isDocumentDate(text, '2025-03')).toBe(false);
    expect(isDocumentDate(normalize('Pressemitteilung vom 12.03.2024. Die Fertigstellung ist im August 2026 vorgesehen.'), '2026-08')).toBe(false);
    // другие форматы первой даты
    expect(isDocumentDate(normalize('Berlin, 18. Februar 2026. Antwort'), '2026-02-18')).toBe(true);
    expect(isDocumentDate(normalize('Stand: Maerz 2026. Schulentwicklungsplan'), '2026-03')).toBe(true);
    expect(isDocumentDate(normalize('Datum 2026-02-18, Drucksache'), '2026-02-18')).toBe(true);
    expect(isDocumentDate(normalize('Ohne Datum'), '2026-02')).toBe(false);
  });

  it('foreignNumbers: the one-liner adds no numbers', () => {
    expect(foreignNumbers('расширят до 3,5 классов к 2027', 'zu einer 3,5-zügigen … Mitte 2027')).toEqual([]);
    expect(foreignNumbers('расширят до 4 классов', 'zu einer 3,5-zügigen')).toEqual(['4']);
  });

  it('outOfWindow: month by Berlin time', () => {
    // 00:30 1 ноября в Берлине — по UTC ещё 31 октября
    expect(outOfWindow({ published: '2026-11-01', planned: null }, new Date('2026-10-31T23:30:00Z'))).toBeNull();
  });

  it('sourceKind: berlin.de only district and Senate pages, not agency news', () => {
    expect(sourceKind(PRESS_URL)).toBe('official');
    expect(sourceKind('https://www.berlin.de/sen/bildung/schule/')).toBe('official');
    expect(sourceKind('https://www.berlin.de/aktuelles/berlin/1234-dpa-schule.php')).toBeNull();
    expect(sourceKind('https://pardok.parlament-berlin.de/starweb/adis/citat/VT/19/SchrAnfr/S19-26268.pdf')).toBe('official');
    expect(sourceKind('https://berlin.de.example.org/ba-x/')).toBeNull();
  });

  it('Draft: impossible date is a schema error', () => {
    expect(() => draft('09G06', [item({ published: '2026-02-31' })])).toThrow(/нет такой даты/);
  });

  it('pageText: charset from Content-Type, main content only, hidden blocks dropped', async () => {
    const body = Buffer.from('<nav>Menü 01.01.2026</nav><main>Bürgel <div hidden>versteckt</div></main>', 'latin1');
    const text = await pageText({ contentType: 'text/html; charset=ISO-8859-1', body });
    expect(text).toContain('Bürgel');
    expect(text).not.toContain('Menü');
    expect(text).not.toContain('versteckt');
  });

  it('pageText: unknown charset in Content-Type falls back to UTF-8', async () => {
    const text = await pageText({ contentType: 'text/html; charset=x-unknown', body: Buffer.from('<main>Bürgel</main>') });
    expect(text).toContain('Bürgel');
  });

  it('outOfWindow: a year-only plan lasts until December', () => {
    expect(outOfWindow({ published: '2025-06', planned: '2026' }, NOW)).toBeNull();
    expect(outOfWindow({ published: '2025-06', planned: '2025' }, NOW)).toMatch(/старше 12/);
  });

  it('outOfWindow: 12 months back, plans within 6 months ahead', () => {
    expect(outOfWindow({ published: '2025-10', planned: null }, NOW)).toBeNull();
    expect(outOfWindow({ published: '2025-09-30', planned: null }, NOW)).toMatch(/старше 12/);
    expect(outOfWindow({ published: '2025-06', planned: '2027-02' }, NOW)).toBeNull();
    expect(outOfWindow({ published: '2025-06', planned: '2027-06' }, NOW)).toMatch(/старше 12/);
    expect(outOfWindow({ published: '2024-06', planned: '2027-01' }, NOW)).toMatch(/старше 12/);
    expect(outOfWindow({ published: '2026-11', planned: null }, NOW)).toBe('дата публикации в будущем');
  });
});

describe('verifyDraft', () => {
  it('over the limit, a fact that contradicts the profile stays first, whatever its topic', async () => {
    const capacity = item({
      category: 'capacity',
      quote: 'Weil in den kommenden Jahren … wird die Melli-Beese-Schule zu einer 3,5-zügigen Grundschule ausgebaut.',
      summaryRu: 'Школу расширяют до 3,5 классов на параллель',
    });
    const field = profile.fields[0][0];
    const ctx = await verifyDraft(draft('09G06', [capacity, item({ contradicts: field })]), MELLI, profile, fetchFixture, NOW, 1);
    expect(ctx.items.map((i) => [i.category, i.contradicts])).toEqual([['construction', field]]);
  });

  it('over the limit, the more important topic stays (capacity before construction), whatever the draft order', async () => {
    const capacity = item({
      category: 'capacity',
      quote: 'Weil in den kommenden Jahren … wird die Melli-Beese-Schule zu einer 3,5-zügigen Grundschule ausgebaut.',
      summaryRu: 'Школу расширяют до 3,5 классов на параллель',
    });
    const ctx = await verifyDraft(draft('09G06', [item({}), capacity]), MELLI, profile, fetchFixture, NOW, 1);
    expect(ctx.items.map((i) => i.category)).toEqual(['capacity']);
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['лимит: не больше 1 фактов']);
  });

  it('keeps only quotes found in an official source, with the school named and the date in the document', async () => {
    const ctx = await verifyDraft(
      draft('09G06', [
        item({ planned: '2027' }),
        item({
          category: 'capacity',
          quote: 'Weil in den kommenden Jahren … wird die Melli-Beese-Schule zu einer 3,5-zügigen Grundschule ausgebaut.',
          summaryRu: 'Школу расширяют до 3,5 классов на параллель',
        }),
        item({ quote: 'Die Fertigstellung des Erweiterungsbaus ist für Ende 2027 geplant.' }),
        item({ summaryRu: 'Пристройку закончат в июне 2027, стоимость 20 млн' }),
        item({ published: '2026-06-30' }),
        item({ url: 'https://www.entwicklungsstadt.de/richtfest-an-der-melli-beese-schule/' }),
        item({ url: 'https://www.berlin.de/ba-treptow-koepenick/nicht-da.php' }),
      ]),
      MELLI,
      profile,
      fetchFixture,
      NOW,
    );
    // одна дата — по важности темы (PRIORITY): места раньше стройки
    expect(ctx.items.map((i) => [i.category, i.host, i.source])).toEqual([
      ['capacity', 'www.berlin.de', 'official'],
      ['construction', 'www.berlin.de', 'official'],
    ]);
    expect(ctx.rejected.map((r) => r.reason)).toEqual([
      'цитаты нет в источнике дословно',
      'в однострочнике числа, которых нет в цитате: 20',
      'первая дата в шапке документа — не 2026-06-30',
      'www.entwicklungsstadt.de/richtfest-an-der-melli-beese-schule/: не в списке официальных источников (config.context)',
      'источник не загрузился: getaddrinfo ENOTFOUND',
    ]);
    expect(ctx.window).toEqual({ publishedFrom: '2025-10', plannedTo: '2027-04' });
  });

  it('mirror copy of an official answer; quote about another school is rejected', async () => {
    const welcome = item({
      category: 'welcome_classes',
      published: '2026-02-18',
      url: ANSWER_URL,
      quote:
        'Die überwiegende Anzahl der Schülerinnen und Schüler der jetzigen Willkommensklassen wird in die Regelklassen der Bruno-H.-Bürgel-Grundschule oder der umliegenden Grundschulen wechseln.',
      summaryRu: 'Willkommensklassen закрываются, дети переходят в обычные классы',
      contradicts: OFFERS,
    });
    const ctx = await verifyDraft(draft('07G32', [welcome]), BUERGEL, profile, fetchFixture, NOW);
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0].source).toBe('mirror');

    const wrong = await verifyDraft(draft('09G06', [{ ...welcome, contradicts: null }]), MELLI, profile, fetchFixture, NOW);
    expect(wrong.rejected.map((r) => r.reason)).toEqual(['рядом с цитатой школа не названа']);

    const noField = await verifyDraft(draft('07G32', [{ ...welcome, contradicts: 'Кружки' }]), BUERGEL, profile, fetchFixture, NOW);
    expect(noField.rejected.map((r) => r.reason)).toEqual(['в профиле нет поля «Кружки»']);
  });

  it('date only in the body text (a plan), not in the header, is rejected', async () => {
    // «Nach der Grundsteinlegung im Juni 2025» — в середине пресс-релиза от 29.06.2026
    const ctx = await verifyDraft(draft('09G06', [item({ published: '2025-06' })]), MELLI, profile, fetchFixture, new Date('2026-06-30T12:00:00Z'));
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['первая дата в шапке документа — не 2025-06']);
  });

  it('a quote about a neighbouring school does not pass for this one', async () => {
    const NAHARIYA = { bsn: '07G23', name: 'Nahariya-Grundschule' };
    const buergelQuote = item({
      category: 'welcome_classes',
      published: '2026-02-18',
      url: ANSWER_URL,
      quote: 'Die überwiegende Anzahl der Schülerinnen und Schüler der jetzigen Willkommensklassen wird in die Regelklassen der Bruno-H.-Bürgel-Grundschule oder der umliegenden Grundschulen wechseln.',
      summaryRu: 'Дети из Willkommensklassen переходят в обычные классы',
    });
    const nahariyaQuote = { ...buergelQuote, quote: 'Für die übrigen Schülerinnen und Schüler stehen Schulplätze in den Willkommensklassen der Nahariya-Grundschule zur Verfügung.' };
    const forNahariya = await verifyDraft(draft('07G23', [buergelQuote, nahariyaQuote]), NAHARIYA, profile, fetchFixture, NOW);
    expect(forNahariya.items.map((i) => i.quote)).toEqual([nahariyaQuote.quote]);
    expect(forNahariya.rejected.map((r) => r.reason)).toEqual(['рядом с цитатой школа не названа']);
    const forBuergel = await verifyDraft(draft('07G32', [nahariyaQuote]), BUERGEL, profile, fetchFixture, NOW);
    expect(forBuergel.rejected.map((r) => r.reason)).toEqual(['рядом с цитатой школа не названа']);
    // в пресс-релизе о Melli-Beese названа и Schule am Ginkobaum — цитата о стройке ей не засчитывается
    const ginko = await verifyDraft(draft('09G07', [item({})]), { bsn: '09G07', name: 'Schule am Ginkobaum (Grundschule)' }, profile, fetchFixture, NOW);
    expect(ginko.rejected.map((r) => r.reason)).toEqual(['рядом с цитатой школа не названа']);
  });

  it('mirror page that is not an authority document, and redirects off the list, are rejected', async () => {
    const blog = 'https://gruene-fraktion-ts.de/blog/schule';
    const moved = 'https://www.berlin.de/ba-treptow-koepenick/moved.php';
    const pages: Record<string, Fetched> = {
      [blog]: { url: blog, status: 200, contentType: 'text/html', body: Buffer.from('<p>Unsere Meinung: Die Fertigstellung des Erweiterungsbaus ist für Mitte 2027 geplant. 29.06.2026 Melli-Beese</p>') },
      [moved]: { ...PAGES[PRESS_URL], url: 'https://example.org/press' },
    };
    const ctx = await verifyDraft(draft('09G06', [item({ url: blog }), item({ url: moved })]), MELLI, profile, async (u) => pages[u], NOW);
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['на сайте-зеркале не документ ведомства', 'переадресация на example.org']);
    // HTML на зеркале не берём, даже если там есть слово «Bezirksamt»
    pages[blog] = { ...pages[blog], body: Buffer.from('<p>Bezirksamt: Die Fertigstellung des Erweiterungsbaus ist für Mitte 2027 geplant. 29.06.2026 Melli-Beese</p>') };
    const html = await verifyDraft(draft('09G06', [item({ url: blog })]), MELLI, profile, async (u) => pages[u], NOW);
    expect(html.rejected.map((r) => r.reason)).toEqual(['на сайте-зеркале не документ ведомства']);
  });

  it('compact: one topic — newest first, at most 2 per category, duplicates dropped', async () => {
    const q = (quote: string) => item({ quote, summaryRu: 'Пристройка и ремонт школы' });
    const ctx = await verifyDraft(
      draft('09G06', [
        q('Die Fertigstellung des Erweiterungsbaus ist für Mitte 2027 geplant.'),
        q('Die Fertigstellung des Erweiterungsbaus ist für Mitte 2027 geplant.'),
        q('Im zweiten Bauabschnitt entsteht nun ein viergeschossiger Erweiterungsbau.'),
        q('Insgesamt sollen alle Arbeiten bis 2029 abgeschlossen sein.'),
      ]),
      MELLI,
      profile,
      fetchFixture,
      NOW,
    );
    expect(ctx.items).toHaveLength(2);
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['повтор', 'лимит: не больше 2 в категории']);
  });

  it('plan year missing from the quote, HTTP error and oversized source are rejected', async () => {
    const big = 'https://www.berlin.de/ba-treptow-koepenick/gross.pdf';
    const gone = 'https://www.berlin.de/ba-treptow-koepenick/weg.php';
    const pages: Record<string, Fetched> = {
      ...PAGES,
      [big]: { url: big, status: 200, contentType: 'application/pdf', body: Buffer.alloc(20 * 1024 * 1024 + 1) },
      [gone]: { url: gone, status: 404, contentType: 'text/html', body: Buffer.alloc(0) },
    };
    const ctx = await verifyDraft(
      draft('09G06', [item({ planned: '2028' }), item({ url: gone }), item({ url: big })]),
      MELLI,
      profile,
      async (u) => pages[u],
      NOW,
    );
    expect(ctx.rejected.map((r) => r.reason)).toEqual([
      'года плана 2028 нет в цитате',
      'источник не загрузился: HTTP 404',
      'источник не загрузился: больше 20 МБ',
    ]);
  });

  it('mirror PDF counts only as an authority answer, not as a party motion or press release', async () => {
    const url = 'https://gruene-fraktion-ts.de/wp-content/uploads/2026/06/papier.pdf';
    const quote = 'Die Fertigstellung des Erweiterungsbaus fuer die Melli-Beese-Schule ist fuer Mitte 2027 geplant.';
    const check = async (head: string) => {
      const body = pdf(`${head} 29.06.2026 ${quote}`);
      return verifyDraft(draft('09G06', [item({ url, quote })]), MELLI, profile, async () => ({ url, status: 200, contentType: 'application/pdf', body }), NOW);
    };
    expect((await check('Bezirksamt Treptow-Koepenick Antwort auf die Muendliche Anfrage Nr. 4')).items).toHaveLength(1);
    const notAnswer = [
      'Fraktion Buendnis 90 Antwort auf die Anfrage', // ведомства нет в бланке
      'Bezirksamt Treptow-Koepenick Pressemitteilung', // ведомство, но не форма ответа
      'Antrag der Fraktion Buendnis 90 an die Bezirksverordnetenversammlung: Das Bezirksamt wird ersucht', // запрос фракции
      'Fraktion in der Bezirksverordnetenversammlung Treptow-Koepenick Die Antwort auf unsere Anfrage zeigt', // пресс-релиз фракции
    ];
    for (const head of notAnswer) expect((await check(head)).rejected.map((r) => r.reason), head).toEqual(['на сайте-зеркале не документ ведомства']);
  });

  it('draft for another school is an error, not an empty block', async () => {
    await expect(verifyDraft(draft('07G32', []), MELLI, profile, fetchFixture, NOW)).rejects.toThrow(/09G06/);
  });

  it("a quote from the deputy's question is not a fact, the authority's answer is", async () => {
    const ask = (quote: string) => item({ category: 'capacity', published: '2026-02-18', url: ANSWER_URL, quote, summaryRu: 'Нехватка помещений в школе' });
    const ctx = await verifyDraft(
      draft('07G32', [
        ask('bislang weder Container noch andere geeignete Unterrichtsräume zur Verfügung stehen'), // вопрос фракции
        ask('nach Rücksprache mit der Schulleitung der Bruno-H.-Bürgel-Grundschule wird die Schule allen Schülerinnen und Schülern einen ordnungsgemäßen Schulunterricht anbieten können'),
      ]),
      BUERGEL,
      profile,
      fetchFixture,
      NOW,
    );
    expect(ctx.items.map((i) => i.quote)).toEqual([expect.stringMatching(/^nach Rücksprache/)]);
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['цитата из вопроса депутата, а не из ответа ведомства']);
  });

  it('inQuestion: Abgeordnetenhaus answer — questions «1. … ?» before «Zu 1. und 2.:»', async () => {
    const text = normalize(await pageText({ contentType: 'application/pdf', body: fixture('context_pardok_07G32.pdf') }));
    const isQuestion = (quote: string) => inQuestion(text, findQuote(text, quote)!);
    expect(isQuestion('für das Jahr 2026 innerhalb des Bezirksamtes abgestimmt und damit vorgesehen worden ist')).toBe(true);
    expect(isQuestion('nicht in die Arbeitsplanung 2026 aufgenommen werden konnte')).toBe(false);
    expect(isQuestion('die äußeren Rahmenbedingungen für das Lehren und Lernen in der Schule zu schaffen')).toBe(false); // Vorbemerkung
    // без маркеров ответа вопросов нет: «1. Juni» и нумерованный список в пресс-релизе — не вопрос
    const press = normalize('Pressemitteilung vom 1. Juni 2026. 1. Der Erweiterungsbau wird bis 2027 fertig.');
    expect(inQuestion(press, findQuote(press, 'Der Erweiterungsbau wird bis 2027 fertig.')!)).toBe(false);
  });
});

describe('fetchFollowing / readContext', () => {
  const resp = (status: number, headers: Record<string, string> = {}, body = '') => ({
    status: () => status,
    headers: () => headers,
    body: async () => Buffer.from(body),
  });
  const api = (pages: Record<string, ReturnType<typeof resp>>) => {
    const get = vi.fn(async (url: string) => pages[url] ?? resp(404));
    return { get, fetch: fetchFollowing({ get } as unknown as Pick<APIRequestContext, 'get'>) };
  };
  const BA = 'https://www.berlin.de/ba-treptow-koepenick';

  it('follows redirects within the source list, by hand', async () => {
    const { get, fetch } = api({
      [`${BA}/alt.php`]: resp(301, { location: '/ba-treptow-koepenick/neu.php' }),
      [`${BA}/neu.php`]: resp(200, { 'content-type': 'text/html' }, '<main>ok</main>'),
    });
    const f = await fetch(`${BA}/alt.php`);
    expect([f.url, f.status, f.contentType, f.body.toString()]).toEqual([`${BA}/neu.php`, 200, 'text/html', '<main>ok</main>']);
    expect(get).toHaveBeenCalledWith(`${BA}/alt.php`, { maxRedirects: 0, maxRetries: 1 });
  });

  it('a redirect off the list is not requested, and verifyDraft rejects it', async () => {
    const { get, fetch } = api({ [PRESS_URL]: resp(302, { location: 'https://example.org/press' }) });
    expect((await fetch(PRESS_URL)).url).toBe('https://example.org/press');
    expect(get.mock.calls.map(([u]) => u)).toEqual([PRESS_URL]);
    const ctx = await verifyDraft(draft('09G06', [item({})]), MELLI, profile, fetch, NOW);
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['переадресация на example.org']);
  });

  it('429 (berlin.de rate limit): waits Retry-After and repeats, at most 3 times', async () => {
    vi.useFakeTimers();
    try {
      const ok = resp(200, { 'content-type': 'text/html' }, '<main>ok</main>');
      const get = vi.fn().mockResolvedValueOnce(resp(429, { 'retry-after': '2' })).mockResolvedValueOnce(ok);
      const pending = fetchFollowing({ get } as unknown as Pick<APIRequestContext, 'get'>)(`${BA}/a.php`);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).status).toBe(200);
      expect(get).toHaveBeenCalledTimes(2);

      const busy = vi.fn(async () => resp(429, { 'retry-after': '1' }));
      const gaveUp = fetchFollowing({ get: busy } as unknown as Pick<APIRequestContext, 'get'>)(`${BA}/a.php`);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await gaveUp).status).toBe(429); // verifyDraft отклонит: «источник не загрузился: HTTP 429»
      expect(busy).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('more than 5 redirects is an error', async () => {
    const { get, fetch } = api({ [`${BA}/a.php`]: resp(302, { location: `${BA}/a.php` }) });
    await expect(fetch(`${BA}/a.php`)).rejects.toThrow('больше 5 переадресаций');
    expect(get).toHaveBeenCalledTimes(6);
  });

  it('readContext: no file — null; broken or foreign file — warning and null, not a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'context-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readContext(dir, ContextSchema)).toBeNull();
      const ctx = await verifyDraft(draft('09G06', []), MELLI, profile, fetchFixture, NOW);
      writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx));
      expect(readContext(dir, ContextSchema)).toEqual(ctx);
      expect(warn).not.toHaveBeenCalled();

      writeFileSync(join(dir, 'context.json'), '{"bsn":');
      expect(readContext(dir, ContextSchema)).toBeNull();
      writeFileSync(join(dir, 'context.json'), JSON.stringify(ctx));
      expect(readContext(dir, PlzContextSchema)).toBeNull(); // context.json по адресу в папке plz
      expect(warn.mock.calls.map(([m]) => m)).toEqual([
        expect.stringMatching(/не читается \(.*JSON.*\) — отчёт без фактов/),
        expect.stringContaining('не читается (структура не та, что пишет npm run context)'),
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('report', () => {
  const school: School = { ...BUERGEL, schulart: 'Grundschule', address: '', ortsteil: 'Lichtenrade', bezirk: '', phone: null, email: null, web: null, lon: 13.4, lat: 52.4 };
  const result: AddressResult = {
    input: { raw: 'Neue Heimat 21' } as AddressResult['input'],
    generatedAt: NOW.toISOString(),
    esbLayer: 'esb_2026',
    status: 'ok',
    address: { street: 'Neue Heimat', house: 21, suffix: null, plz: '12305', ortsteil: 'Lichtenrade', bezirk: 'Tempelhof-Schöneberg', x25833: 0, y25833: 0, lon: 13.4, lat: 52.4 },
    alternatives: [],
    catchment: { esb: '0732', esbText: null, status: 'exact', schools: [school] },
    schools: [{ school, role: 'main', data: { bsn: '07G32', portraitUrl: 'https://example.org', profile, pages: {}, inspections: [], screenshots: [] } }],
    warnings: [],
  };

  it('joint zone: the other assigned school gets its own block with marker and its verified facts', async () => {
    const other: School = { ...school, bsn: '07G40', name: '40. Schule (Grundschule)' };
    const joint: AddressResult = {
      ...result,
      catchment: { ...result.catchment!, status: 'joint', schools: [school, other] },
      schools: [...result.schools, { school: other, role: 'joint', data: { ...result.schools[0].data, bsn: '07G40' } }],
    };
    const ctx = {
      schools: [
        await verifyDraft(draft('07G32', []), BUERGEL, profile, fetchFixture, NOW),
        await verifyDraft(draft('07G40', []), other, profile, fetchFixture, NOW),
      ],
    };
    const html = renderReport(joint, ctx);
    expect(html).toContain('<h2>Одна из закреплённых школ общей зоны · 07G32</h2>');
    expect(html).toContain('<h2>Тоже закреплённая школа общей зоны · 07G40</h2>');
    expect(html.match(/Сообщений о школе за этот период не найдено/g)).toHaveLength(2); // факты проверены по обеим
    expect(html).toContain('<td>закреплённая (общая зона)</td>');
  });

  it('the nearest school is not called assigned when the zone gives no school', () => {
    const titled = (catchment: Catchment) => renderReport({ ...result, catchment }).match(/<h2>([^<]*) · 07G32<\/h2>/)?.[1];
    expect(titled(result.catchment!)).toBe('Закреплённая школа');
    expect(titled({ ...result.catchment!, status: 'matched_by_code' })).toBe('Вероятно закреплённая школа');
    for (const status of ['no_school_in_zone', 'no_zone'] as const)
      expect(titled({ ...result.catchment!, status, esb: status === 'no_zone' ? null : '0732' })).toBe('Ближайшая школа — закреплённая не определена');
    expect(titled({ ...result.catchment!, status: 'ambiguous' })).toBe('Ближайшая из школ зоны — закреплённая не определена');
  });

  it('no context.json — no block; with it — facts without quotes and a flag on the outdated profile field', async () => {
    expect(renderReport(result)).not.toContain('Что известно из официальных источников');
    const welcome = item({
      category: 'welcome_classes',
      published: '2026-02-18',
      url: ANSWER_URL,
      quote:
        'wird in die Regelklassen der Bruno-H.-Bürgel-Grundschule oder der umliegenden Grundschulen wechseln. Für die übrigen Schülerinnen und Schüler stehen Schulplätze in den Willkommensklassen der Nahariya-Grundschule zur Verfügung.',
      summaryRu: 'Новеньких без немецкого направляют в Nahariya-Grundschule',
      contradicts: OFFERS,
    });
    const ctx = await verifyDraft(draft('07G32', [welcome]), BUERGEL, profile, fetchFixture, NOW);
    const html = renderReport(result, ctx);
    expect(html).toContain('Что известно из официальных источников');
    expect(html).toContain('Классы для детей без немецкого: Новеньких без немецкого направляют в Nahariya-Grundschule');
    expect(html).not.toContain('Für die übrigen'); // цитата — только в context.json
    expect(html).toContain('<h2>Профиль и контакты школы</h2>');
    expect(html).toContain('⚠️ Возможно, устарело: 2026-02-18');
    expect(renderReport(result, { ...ctx, bsn: '09G06' })).not.toContain('Что известно');
    // пояснение — только к темам, которые есть в фактах
    expect(html).toContain('<b>Классы для детей без немецкого.</b> Willkommensklasse');
    expect(html).not.toContain('<b>Стройка и ремонт.</b>');
    // источник-зеркало подписан, дата проверки и окно — под фактами, план — рядом с фактом
    expect(html).toContain('копия документа ведомства · ');
    expect(html).toContain('Проверено 2026-10-23: публикации с 2025-10 и планы до 2027-04');
    expect(renderReport(result, { ...ctx, items: [{ ...ctx.items[0], planned: '2027' }] })).toContain('(план: 2027)');
  });

  it('checked, nothing found — one line, not a missing block', async () => {
    const ctx = await verifyDraft(draft('07G32', []), BUERGEL, profile, fetchFixture, NOW);
    expect(renderReport(result, ctx)).toContain('Сообщений о школе за этот период не найдено.');
  });
});

describe('PLZ', () => {
  it('the same school twice in a draft is a schema error', () => {
    const d = { bsn: '09G06', queries: ['q'], items: [] };
    expect(() => PlzDraft.parse({ schools: [d, d] })).toThrow(/дважды/);
  });

  it('context.json of the wrong shape is rejected by the schema, not by the renderer', () => {
    expect(() => PlzContextSchema.parse({})).toThrow();
    expect(() => ContextSchema.parse({ bsn: '07G32', items: [] })).toThrow();
  });

  const school: School = { ...MELLI, schulart: 'Grundschule', address: '', ortsteil: 'Johannisthal', bezirk: '', phone: null, email: null, web: null, lon: 13.5, lat: 52.4 };
  const other: School = { ...school, bsn: '09G07', name: 'Schule am Ginkobaum (Grundschule)' };
  const data = (bsn: string) => ({ bsn, portraitUrl: 'https://example.org', profile, pages: {}, inspections: [], screenshots: [] });
  const result: PlzResult = {
    input: { plz: '12487', street: null },
    generatedAt: NOW.toISOString(),
    esbLayer: 'esb_2026',
    status: 'ok',
    addresses: 10,
    zones: [
      { esb: '0906', esbText: null, status: 'exact', schools: [school], addresses: 6, plzs: [], streets: [] },
      { esb: '0907', esbText: null, status: 'exact', schools: [other], addresses: 4, plzs: [], streets: [] },
    ],
    schools: [
      { school, data: data('09G06') },
      { school: other, data: data('09G07') },
    ],
    warnings: [],
  };
  const quotes = [
    'Die Fertigstellung des Erweiterungsbaus ist für Mitte 2027 geplant.',
    'Im zweiten Bauabschnitt entsteht nun ein viergeschossiger Erweiterungsbau.',
    'Bereits 2023 wurde ein temporärer Schulergänzungsbau in Containerbauweise errichtet und seit dem Schuljahr 2023/24 genutzt.',
    'Insgesamt sollen alle Arbeiten bis 2029 abgeschlossen sein.',
  ];

  it('zone matched by code: the probable school and the other schools of the zone as candidates', () => {
    const html = renderPlzReport({ ...result, zones: [{ ...result.zones[0], status: 'matched_by_code', schools: [school, other] }] });
    expect(html).toContain('<small>вероятно закреплённая</small><br>Melli-Beese-Schule');
    expect(html).toContain('<small>кандидат</small><br>Schule am Ginkobaum');
    expect(renderPlzReport(result)).not.toContain('вероятно закреплённая');
  });

  it('at most 3 facts per school; facts inside the block of their school; no context.json — report unchanged', async () => {
    const items = quotes.map((quote, i) => item({ quote, category: i < 2 ? 'construction' : 'capacity', summaryRu: 'Пристройка и места в школе' }));
    const melli = await verifyDraft(draft('09G06', items), MELLI, profile, fetchFixture, NOW, 3);
    expect(melli.items).toHaveLength(3);
    expect(melli.rejected.map((r) => r.reason)).toEqual(['лимит: не больше 3 фактов']);
    const ginko = await verifyDraft(draft('09G07', []), other, profile, fetchFixture, NOW, 3);

    expect(renderPlzReport(result)).not.toContain('Что известно');
    const html = renderPlzReport(result, { schools: [melli, ginko] });
    const melliBlock = html.slice(html.indexOf('<h3>Melli-Beese'), html.indexOf('<h3>Schule am Ginkobaum'));
    expect(melliBlock).toContain('<b>Что известно из официальных источников</b>');
    expect(melliBlock.match(/<li>/g)).toHaveLength(3);
    expect(html.slice(html.indexOf('<h3>Schule am Ginkobaum'))).toContain('Официальных сообщений о школе за период не найдено.');
    expect(html).toContain('Проверено 2026-10-23');
  });
});
