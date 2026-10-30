import { describe, expect, it } from 'vitest';
import { sourceKind, type Fetched } from '../../src/context.js';
import { schulamt, verifySchulamt, type Schulamt } from '../../src/schulamt.js';

const html = (url: string, body: string, status = 200): Fetched => ({ url, status, contentType: 'text/html', body: Buffer.from(`<nav>Menü</nav><main>${body}</main>`) });

const ROLE = 'Das Schulamt ist zuständig für die Schulplatzvergabe';
const SA = 'Die Schulaufsicht in den Berliner Bezirken kümmert sich vor Ort um alle inneren Schulangelegenheiten.';
const snap: Schulamt = {
  checkedAt: '2026-10-30',
  roles: {
    schulamt: { url: 'https://www.berlin.de/sen/a', quote: ROLE, summaryRu: 'Места распределяет Schulamt' },
    schulaufsicht: { url: 'https://www.berlin.de/sen/b', quote: SA, summaryRu: 'Надзор за школами' },
  },
  bezirke: {
    'Treptow-Köpenick': {
      schulamt: { url: 'https://www.berlin.de/ba-tk/schule/', address: 'Alt-Köpenick 21, 12555 Berlin', email: 'schulamt@ba-tk.berlin.de' },
      schulaufsicht: { url: 'https://www.berlin.de/sen/b', address: null, email: null },
    },
  },
};
// как на сайте: адрес в две строки, ящик только в mailto:
const pages: Record<string, string> = {
  'https://www.berlin.de/sen/a': `${ROLE}.`,
  'https://www.berlin.de/sen/b': SA,
  'https://www.berlin.de/ba-tk/schule/': 'Dienstsitz: Alt-Köpenick 21\n12555 Berlin <a href="mailto:Schulamt@ba-tk.berlin.de">E-Mail an Schulamt</a>',
};

describe('schulamt snapshot', () => {
  it('config/schulamt.json parses: all 12 Bezirke, every page official', () => {
    const s = schulamt();
    expect(Object.keys(s.bezirke)).toHaveLength(12);
    const urls = [...Object.values(s.roles), ...Object.values(s.bezirke).flatMap((b) => [b.schulamt, b.schulaufsicht])].map((o) => o.url);
    expect(urls.filter((u) => sourceKind(u) !== 'official')).toEqual([]);
  });

  it('address over two lines and email only in mailto: are found → no problems', async () => {
    expect(await verifySchulamt(snap, async (url) => html(url, pages[url]), ['Treptow-Köpenick'])).toEqual([]);
  });

  it('a moved address, a gone email, a dead page once and a Bezirk without entry are each named', async () => {
    const fetch = async (url: string) =>
      url.includes('/sen/b') ? html(url, '', 404) : html(url, url.includes('ba-tk') ? 'Neue Adresse: Rathaus Treptow, Neue Krugallee 4' : pages[url]);
    expect(await verifySchulamt(snap, fetch, ['Treptow-Köpenick', 'Pankow'])).toEqual([
      'https://www.berlin.de/sen/b: HTTP 404',
      'Treptow-Köpenick schulamt: адреса «Alt-Köpenick 21, 12555 Berlin» больше нет на https://www.berlin.de/ba-tk/schule/',
      'Treptow-Köpenick schulamt: email schulamt@ba-tk.berlin.de больше нет на https://www.berlin.de/ba-tk/schule/',
      'нет записи для округов: Pankow',
    ]);
  });

  it('an address from addressSource is checked there, not on the office page', async () => {
    const pdf = 'https://www.berlin.de/sen/c.pdf';
    const sourced: Schulamt = {
      ...snap,
      bezirke: { 'Treptow-Köpenick': { ...snap.bezirke['Treptow-Köpenick'], schulaufsicht: { url: 'https://www.berlin.de/sen/b', address: 'Luisenstr. 16, 12557 Berlin', addressSource: pdf, email: null } } },
    };
    // на странице ведомства — старый адрес, в документе SenBJF — новый, в две строки
    const fetch = (pdfText: string) => async (url: string) => html(url, url === pdf ? pdfText : `${pages[url]} Dienstsitz: Otto-Franke-Str. 88, 12489 Berlin`);
    expect(await verifySchulamt(sourced, fetch('Schulaufsicht Treptow-\nKöpenick\nLuisenstr. 16\n12557 Berlin'))).toEqual([]);
    expect(await verifySchulamt(sourced, fetch('Schulaufsicht Treptow-Köpenick: neue Adresse folgt'))).toEqual([
      `Treptow-Köpenick schulaufsicht: адреса «Luisenstr. 16, 12557 Berlin» больше нет на ${pdf}`,
    ]);
  });

  it('a redirect off the official hosts is refused', async () => {
    const fetch = async (url: string) => (url.includes('ba-tk') ? html('https://example.org/copy', pages[url]) : html(url, pages[url]));
    expect(await verifySchulamt(snap, fetch)).toEqual(['https://www.berlin.de/ba-tk/schule/: example.org: не официальный источник (config.context.officialSources)']);
  });
});
