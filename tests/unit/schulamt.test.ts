import { describe, expect, it } from 'vitest';
import { sourceKind, type Fetched } from '../../src/context.js';
import { renderPlzReport } from '../../src/report.js';
import { sameAddress, schulamt, verifySchulamt, type Schulamt } from '../../src/schulamt.js';

const html = (url: string, body: string, status = 200): Fetched => ({ url, status, contentType: 'text/html', body: Buffer.from(`<nav>Menü</nav><main>${body}</main>`) });

const ROLE = 'Das Schulamt ist zuständig für die Schulplatzvergabe';
const SA = 'Die Schulaufsicht in den Berliner Bezirken kümmert sich vor Ort um alle inneren Schulangelegenheiten.';
const DIR = 'https://www.berlin.de/sen/dir.pdf';
const TK = { address: 'Luisenstraße 16, 12557 Berlin', phone: '030 90249-2211/-12/-15', email: '09schulaufsicht@senbjf.berlin.de' };
const snap: Schulamt = {
  checkedAt: '2026-10-30',
  roles: {
    schulamt: { url: 'https://www.berlin.de/sen/a', quote: ROLE, summaryRu: 'Места распределяет Schulamt' },
    schulaufsicht: { url: 'https://www.berlin.de/sen/b', quote: SA, summaryRu: 'Надзор за школами' },
  },
  directory: { url: DIR, title: 'Schulanfang' },
  bezirke: {
    'Treptow-Köpenick': {
      schulamt: { url: 'https://www.berlin.de/ba-tk/schule/', address: 'Alt-Köpenick 21, 12555 Berlin', email: 'schulamt@ba-tk.berlin.de' },
      schulaufsicht: { url: 'https://www.berlin.de/sen/b', address: null, email: null, directory: TK },
    },
  },
};
// как на сайте: адрес в две строки, ящик только в mailto:
const pages: Record<string, string> = {
  'https://www.berlin.de/sen/a': `${ROLE}.`,
  'https://www.berlin.de/sen/b': SA,
  'https://www.berlin.de/ba-tk/schule/': 'Dienstsitz: Alt-Köpenick 21\n12555 Berlin <a href="mailto:Schulamt@ba-tk.berlin.de">E-Mail an Schulamt</a>',
  // как в PDF SenBJF: заголовок округа, адрес, телефон, ящик — каждое с новой строки
  [DIR]:
    'TEMPELHOF-SCHÖNEBERG\nAlarichstraße 12–17, 12105 Berlin\nTel.: 030 90277-6494\nE-Mail: 07schulaufsicht@senbjf.berlin.de\n' +
    'TREPTOW-KÖPENICK\nLuisenstraße 16, 12557 Berlin\nTel.: 030 90249-2211/-12/-15\nE-Mail: 09schulaufsicht@senbjf.berlin.de',
};

describe('schulamt snapshot', () => {
  it('config/schulamt.json parses: all 12 Bezirke, every page official', () => {
    const s = schulamt();
    expect(Object.keys(s.bezirke)).toHaveLength(12);
    const urls = [...Object.values(s.roles), s.directory, ...Object.values(s.bezirke).flatMap((b) => [b.schulamt, b.schulaufsicht])].map((o) => o.url);
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
      bezirke: {
        'Treptow-Köpenick': {
          ...snap.bezirke['Treptow-Köpenick'],
          schulaufsicht: { url: 'https://www.berlin.de/sen/b', address: 'Luisenstr. 16, 12557 Berlin', addressSource: pdf, email: null, directory: TK },
        },
      },
    };
    // на странице ведомства — старый адрес, в документе SenBJF — новый, в две строки
    const fetch = (pdfText: string) => async (url: string) =>
      html(url, url === pdf ? pdfText : url === DIR ? pages[DIR] : `${pages[url]} Dienstsitz: Otto-Franke-Str. 88, 12489 Berlin`);
    expect(await verifySchulamt(sourced, fetch('Schulaufsicht Treptow-\nKöpenick\nLuisenstr. 16\n12557 Berlin'))).toEqual([]);
    expect(await verifySchulamt(sourced, fetch('Schulaufsicht Treptow-Köpenick: neue Adresse folgt'))).toEqual([
      `Treptow-Köpenick schulaufsicht: адреса «Luisenstr. 16, 12557 Berlin» больше нет на ${pdf}`,
    ]);
  });

  it('the directory record must stand under its own Bezirk heading, phone and mailbox included', async () => {
    const withListing = (directory: typeof TK): Schulamt => ({
      ...snap,
      bezirke: { 'Treptow-Köpenick': { ...snap.bezirke['Treptow-Köpenick'], schulaufsicht: { ...snap.bezirke['Treptow-Köpenick'].schulaufsicht, directory } } },
    });
    const fetch = async (url: string) => html(url, pages[url]);
    const changed = `Treptow-Köpenick schulaufsicht: в справочнике ${DIR} запись округа изменилась (адрес, телефон или ящик)`;
    expect(await verifySchulamt(withListing({ ...TK, phone: '030 90249-9999' }), fetch)).toEqual([changed]);
    // адрес соседнего округа из того же справочника — не запись Treptow-Köpenick
    expect(await verifySchulamt(withListing({ ...TK, address: 'Alarichstraße 12–17, 12105 Berlin' }), fetch)).toEqual([changed]);
  });

  it('sameAddress: spelling of street and house range is one building, another street or number is not', () => {
    expect(sameAddress('Waldschulallee 29, 14055 Berlin', 'Waldschulallee 29–31, 14055 Berlin')).toBe(true);
    expect(sameAddress('Tino-Schwierzina-Str. 32, 13089 Berlin', 'Tino-Schwierzina-Straße 32, 13089 Berlin')).toBe(true);
    expect(sameAddress('Alarichstr. 12-17, 12105 Berlin', 'Alarichstraße 12–17, 12105 Berlin')).toBe(true);
    expect(sameAddress('Wilskistraße 84, 14163 Berlin', 'Hartmannsweilerweg 65, 14163 Berlin')).toBe(false);
    expect(sameAddress('Fritz-Lang-Straße 6, 12627 Berlin', 'Alice-Salomon-Platz 3, 12627 Berlin')).toBe(false);
    expect(sameAddress('Streitstr. 6, 13587 Berlin', 'Streitstraße 9, 13587 Berlin')).toBe(false);
    expect(sameAddress('Rathaus Köpenick', 'Rathaus Köpenick')).toBe(false); // не разобран — пусть смотрит человек
  });

  it('report: differing Schulaufsicht addresses get ⚠️ with both, matching ones one address; phone and mailbox from the directory', () => {
    const line = (bezirk: string) => {
      const school = { bsn: 'X', name: 'X', schulart: 'Grundschule', address: '', ortsteil: '', bezirk, phone: null, email: null, web: null, lon: 13.4, lat: 52.5 };
      const data = { profile: { name: 'X', fields: [] }, pages: {}, screenshots: [] };
      const r = { input: { plz: '10000' }, generatedAt: '2026-10-30T00:00:00Z', esbLayer: 'esb', status: 'ok', addresses: 0, zones: [], warnings: [], schools: [{ school, data }] };
      return renderPlzReport(r as never).match(/<p>🔎[^]*?<\/p>/)![0];
    };
    // Marzahn-Hellersdorf: страница округа — Fritz-Lang-Straße 6, справочник — Alice-Salomon-Platz 3
    expect(line('Marzahn-Hellersdorf')).toContain('⚠️ адрес в источниках расходится');
    const cw = line('Charlottenburg-Wilmersdorf');
    expect(cw).not.toContain('⚠️');
    expect(cw).toContain('Waldschulallee 29, 14055 Berlin');
    expect(cw).toContain('<a href="tel:030902925102">030 90292-5102</a>');
    expect(cw).toContain('mailto:04schulaufsicht@senbjf.berlin.de');
  });

  it('a redirect off the official hosts is refused', async () => {
    const fetch = async (url: string) => (url.includes('ba-tk') ? html('https://example.org/copy', pages[url]) : html(url, pages[url]));
    expect(await verifySchulamt(snap, fetch)).toEqual(['https://www.berlin.de/ba-tk/schule/: example.org: не официальный источник (config.context.officialSources)']);
  });
});
