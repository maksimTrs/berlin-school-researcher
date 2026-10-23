import { describe, expect, it } from 'vitest';
import { parseAddress } from '../../src/schema.js';

describe('parseAddress', () => {
  it.each([
    ['Ruppiner Straße 47, 10115', { street: 'Ruppiner Straße', house: 47, suffix: null, plz: '10115', ortsteil: null }],
    ['Beusselstraße 44F, 10553', { street: 'Beusselstraße', house: 44, suffix: 'F', plz: '10553' }],
    ['Bergmannstr 5 Kreuzberg', { street: 'Bergmannstr', house: 5, plz: null, ortsteil: 'Kreuzberg' }],
    ['Kastanienallee 12', { street: 'Kastanienallee', house: 12, plz: null }],
    ['Straße des 17. Juni 100', { street: 'Straße des 17. Juni', house: 100, plz: null }],
    ['Straße 52 3, 12357', { street: 'Straße 52', house: 3, plz: '12357' }],
    ['Joachim-Friedrich-Straße 35-36, 10711', { street: 'Joachim-Friedrich-Straße', house: 35, plz: '10711' }],
  ])('%s', (raw, expected) => {
    expect(parseAddress(raw)).toMatchObject(expected);
  });

  it('no house number → readable error', () => {
    expect(() => parseAddress('Kastanienallee')).toThrow(/Не разобран адрес/);
  });
});
