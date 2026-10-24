import { describe, expect, it } from 'vitest';
import type { Fetched } from '../../src/context.js';
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
    { url: 'https://www.berlin.de/sen/a', quote: 'Das Schulamt ist zuständig für die Schulplatzvergabe', summaryRu: 'Место даёт Schulamt' },
    { url: 'https://www.berlin.de/sen/a', quote: 'Kinder bis 7 Jahre … direkt in die Schulanfangsphase', summaryRu: 'До 7 лет — обычный класс' },
  ],
  links: [{ url: 'https://www.berlin.de/sen/b.pdf', label: 'PDF' }],
};

describe('zuzug snapshot', () => {
  it('config/zuzug.json parses', () => {
    expect(zuzug().items.length).toBeGreaterThan(0);
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
});
