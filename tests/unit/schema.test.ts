import { describe, expect, it } from 'vitest';
import { Input, parseAddress } from '../../src/schema.js';

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

  // форматы карточек объявлений (ImmoScout24, Kleinanzeigen, WG-Gesucht)
  it.each([
    ['Esmarchstraße 13, 10407 Prenzlauer Berg (Prenzlauer Berg)', { street: 'Esmarchstraße', house: 13, plz: '10407', ortsteil: 'Prenzlauer Berg (Prenzlauer Berg)' }],
    ['Knaackstraße 12, Prenzlauer Berg (Prenzlauer Berg)', { street: 'Knaackstraße', house: 12, plz: null, ortsteil: 'Prenzlauer Berg (Prenzlauer Berg)' }],
    ['Adresse: Rodenbergstraße 53, Prenzlauer Berg (Prenzlauer Berg)', { street: 'Rodenbergstraße', house: 53, ortsteil: 'Prenzlauer Berg (Prenzlauer Berg)' }],
    ['Seesener Straße 17, 10711 Berlin, Halensee (Wilmersdorf)', { street: 'Seesener Straße', house: 17, plz: '10711', ortsteil: 'Halensee (Wilmersdorf)' }],
    ['Katharinenstr. 3, 10711 Berlin - Halensee', { street: 'Katharinenstr.', house: 3, plz: '10711', ortsteil: 'Halensee' }],
    ['Esmarchstrasse 21, 10407', { street: 'Esmarchstrasse', house: 21, plz: '10407' }],
    ['Kurfürstendamm 132A, 10711 Berlin', { street: 'Kurfürstendamm', house: 132, suffix: 'A', plz: '10711', ortsteil: null }],
    ['Hauptstraße 12 a, 10827 Berlin', { street: 'Hauptstraße', house: 12, suffix: 'a', plz: '10827' }],
    ['Karl-Marx-Allee 12–14, 10243 Berlin', { street: 'Karl-Marx-Allee', house: 12, plz: '10243' }],
    ['Danziger Str. 50/52 10435 Berlin', { street: 'Danziger Str.', house: 50, plz: '10435' }],
    ['Kastanienallee Nr. 12', { street: 'Kastanienallee', house: 12 }],
    ['  Behmstraße   65 ,  13357  ', { street: 'Behmstraße', house: 65, plz: '13357' }],
    // район перед PLZ
    ['Varziner Straße 13, Friedenau, 12161 Berlin', { street: 'Varziner Straße', house: 13, suffix: null, plz: '12161', ortsteil: 'Friedenau' }],
    ['Katharinenstr. 3a, Halensee, 10711', { street: 'Katharinenstr.', house: 3, suffix: 'a', plz: '10711', ortsteil: 'Halensee' }],
    ['Straße des 17. Juni 100, Tiergarten, 10557', { street: 'Straße des 17. Juni', house: 100, plz: '10557', ortsteil: 'Tiergarten' }],
    ['Varziner Straße 13, Berlin-Friedenau, 12161', { plz: '12161', ortsteil: 'Friedenau' }],
    ['Varziner Straße 13, Berlin, 12161', { plz: '12161', ortsteil: null }],
    ['Varziner Straße 13, Friedenau, 12161, Berlin', { plz: '12161', ortsteil: 'Friedenau' }],
  ])('listing: %s', (raw, expected) => {
    expect(parseAddress(raw)).toMatchObject(expected);
  });

  it.each([
    'Kastanienallee', // нет номера
    'Schivelbeiner Straße, 10439 Prenzlauer Berg (Prenzlauer Berg)', // номер скрыт в объявлении
    'Berlin, Halensee (Wilmersdorf)', // только район
    'Hauptstraße 5 1. OG', // этаж — лишняя цифра, не угадываем
  ])('not parsed, readable error: %s', (raw) => {
    expect(() => parseAddress(raw)).toThrow(/Не разобран адрес/);
  });
});

describe('Input', () => {
  const a = { street: 'Kastanienallee', house: 12 };
  it('accepts up to maxAddresses (5)', () => {
    expect(Input.parse({ addresses: Array(5).fill(a) }).addresses).toHaveLength(5);
  });
  it('raw-only entries are parsed by code, mixed with structured ones', () => {
    const { addresses } = Input.parse({
      addresses: [{ raw: 'Seesener Straße 17, 10711 Berlin, Halensee (Wilmersdorf)' }, a],
    });
    expect(addresses[0]).toMatchObject({ street: 'Seesener Straße', house: 17, plz: '10711', ortsteil: 'Halensee (Wilmersdorf)' });
    expect(addresses[1]).toMatchObject(a);
  });

  it('unparsable raw entry → error names the address', () => {
    expect(() => Input.parse({ addresses: [{ raw: 'Schivelbeiner Straße, 10439 Prenzlauer Berg' }] })).toThrow(
      /Не разобран адрес: «Schivelbeiner Straße/,
    );
  });

  it('rejects 6 addresses and non-integer house', () => {
    expect(() => Input.parse({ addresses: Array(6).fill(a) })).toThrow();
    expect(() => Input.parse({ addresses: [{ street: 'Kastanienallee', house: '12a' }] })).toThrow();
  });
});
