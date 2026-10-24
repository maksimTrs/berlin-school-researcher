import { describe, expect, it } from 'vitest';
import type { Fetched } from '../../src/context.js';
import { foreignNumbers, type Fetched as F } from '../../src/context.js';
import { verifyZuzug, zuzug, type Zuzug } from '../../src/zuzug.js';

const html = (url: string, text: string, status = 200): Fetched => ({
  url,
  status,
  contentType: 'text/html',
  body: Buffer.from(`<nav>Menü</nav><main>${text}</main>`),
});

const snap: Zuzug = {
  checkedAt: '2026-10-24',
  items: [
    { url: 'https://www.berlin.de/sen/a', published: null, quote: 'Das Schulamt ist zuständig für die Schulplatzvergabe', summaryRu: 'Место даёт Schulamt' },
    { url: 'https://www.berlin.de/sen/a', published: null, quote: 'Kinder bis 7 Jahre … direkt in die Schulanfangsphase', summaryRu: 'До 7 лет — обычный класс' },
  ],
  links: [{ url: 'https://www.berlin.de/sen/b.pdf', label: 'PDF' }],
};

describe('zuzug snapshot', () => {
  it('config/zuzug.json parses, and no summary adds a number its quote lacks', () => {
    expect(zuzug().items.length).toBeGreaterThan(0);
    expect(zuzug().items.filter((i) => foreignNumbers(i.summaryRu, i.quote).length).map((i) => i.summaryRu)).toEqual([]);
  });

  it('a summary with a number not in its quote is a problem', async () => {
    const snap1: Zuzug = {
      checkedAt: '2026-10-24',
      items: [{ url: 'https://www.berlin.de/sen/a', published: null, quote: 'in den ersten beiden Jahrgangsstufen im Rahmen der Schulanfangsphase', summaryRu: 'В 1–2 классе — Schulanfangsphase' }],
      links: [],
    };
    const fetch = async (url: string): Promise<F> => html(url, 'in den ersten beiden Jahrgangsstufen im Rahmen der Schulanfangsphase');
    expect(await verifyZuzug(snap1, fetch)).toEqual(['https://www.berlin.de/sen/a: в пересказе числа, которых нет в цитате: 1, 2']);
  });

  it('all quotes found and links load → no problems', async () => {
    const fetch = async (url: string) =>
      html(url, 'Das Schulamt ist zuständig für die Schulplatzvergabe. Kinder bis 7 Jahre werden direkt in die Schulanfangsphase aufgenommen.');
    expect(await verifyZuzug(snap, fetch)).toEqual([]);
  });

  it('a quote gone from the document and a dead link are named once each', async () => {
    const fetch = async (url: string) =>
      url.endsWith('.pdf') ? html(url, '', 404) : html(url, 'Das Schulamt ist zuständig für die Schulplatzvergabe.');
    expect(await verifyZuzug(snap, fetch)).toEqual([
      'https://www.berlin.de/sen/a: цитаты «Kinder bis 7 Jahre … direkt in die Schulanfangsphase…» больше нет в документе',
      'https://www.berlin.de/sen/b.pdf: HTTP 404',
    ]);
  });

  it('the document date must be the first date in its header; an unofficial host is refused', async () => {
    const dated: Zuzug = {
      checkedAt: '2026-10-24',
      items: [{ url: 'https://www.berlin.de/sen/c.pdf', published: '2024-09', quote: 'Das Schulamt ist zuständig für die Schulplatzvergabe', summaryRu: 'Место даёт Schulamt' }],
      links: [{ url: 'https://example.org/copy.pdf', label: 'копия' }],
    };
    const fetch = async (url: string) =>
      html(url, `Auflage ${url.includes('berlin.de') ? 'März 2026' : 'September 2024'}. Das Schulamt ist zuständig für die Schulplatzvergabe.`);
    expect(await verifyZuzug(dated, fetch)).toEqual([
      'https://www.berlin.de/sen/c.pdf: первая дата в шапке документа — не 2024-09 (вышла новая редакция?)',
      'https://example.org/copy.pdf: example.org: не официальный источник (config.context.officialSources)',
    ]);
  });
});
