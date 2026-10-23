import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Draft,
  findQuote,
  foreignNumbers,
  hasDate,
  mentionsSchool,
  normalize,
  outOfWindow,
  pageText,
  schoolKeys,
  sourceKind,
  verifyDraft,
  type DraftItem,
  type Fetched,
} from '../../src/context.js';
import type { Profile } from '../../src/extract.js';
import type { School } from '../../src/geo.js';
import { renderReport, type AddressResult } from '../../src/report.js';

// реальные источники: пресс-релиз округа (berlin.de) и ответ Bezirksamt на запрос в BVV (копия на сайте фракции)
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

  it('hasDate: day and month precision', () => {
    const text = normalize('Pressemitteilung vom 29.06.2026 · am 18. Februar 2026 · März 2025');
    expect(hasDate(text, '2026-06-29')).toBe(true);
    expect(hasDate(text, '2026-02-18')).toBe(true);
    expect(hasDate(text, '2026-06')).toBe(true);
    expect(hasDate(text, '2025-03')).toBe(true);
    expect(hasDate(text, '2026-06-28')).toBe(false);
    expect(hasDate(text, '2026-07')).toBe(false);
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
    expect(ctx.items.map((i) => [i.category, i.host, i.source])).toEqual([
      ['construction', 'www.berlin.de', 'official'],
      ['capacity', 'www.berlin.de', 'official'],
    ]);
    expect(ctx.rejected.map((r) => r.reason)).toEqual([
      'цитаты нет в источнике дословно',
      'в однострочнике числа, которых нет в цитате: 20',
      'даты 2026-06-30 нет в шапке документа',
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
    expect(ctx.rejected.map((r) => r.reason)).toEqual(['даты 2025-06 нет в шапке документа']);
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

  it('compact: newest first, at most 2 per category, duplicates dropped', async () => {
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

  it('draft for another school is an error, not an empty block', async () => {
    await expect(verifyDraft(draft('07G32', []), MELLI, profile, fetchFixture, NOW)).rejects.toThrow(/09G06/);
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

  it('no context.json — no block; with it — facts without quotes and a flag on the outdated profile field', async () => {
    expect(renderReport(result)).not.toContain('Что известно из официальных источников');
    const welcome = item({
      category: 'welcome_classes',
      published: '2026-02-18',
      url: ANSWER_URL,
      quote: 'Für die übrigen Schülerinnen und Schüler stehen Schulplätze in den Willkommensklassen der Nahariya-Grundschule zur Verfügung.',
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
  });

  it('checked, nothing found — one line, not a missing block', async () => {
    const ctx = await verifyDraft(draft('07G32', []), BUERGEL, profile, fetchFixture, NOW);
    expect(renderReport(result, ctx)).toContain('Сообщений о школе за этот период не найдено.');
  });
});
