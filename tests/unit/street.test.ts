import { describe, expect, it } from 'vitest';
import { inArea, normStreet, streetPattern } from '../../src/geo.js';

describe('street matching', () => {
  it.each([
    ['Ruppiner Straße', 'Ruppiner Strasse'],
    ['Bergmannstraße', 'Bergmannstr.'],
    ['Großbeerenstraße', 'Grossbeerenstr'],
    ['Müllerstraße', 'Muellerstrasse'],
    ['Straße des 17. Juni', 'strasse des 17. juni'],
  ])('%s ≡ %s', (registry, typed) => {
    expect(normStreet(typed)).toBe(normStreet(registry));
  });

  it('ILIKE pattern tolerates ß/ss and umlaut spellings', () => {
    expect(streetPattern('Großbeerenstraße')).toBe('gro%beerenstr%');
    expect(streetPattern('Grossbeerenstr')).toBe('gro%beerenstr%');
    expect(streetPattern('Müllerstr.')).toBe('m%llerstr%');
  });

  it('different streets stay different', () => {
    expect(normStreet('Am Waldidyll')).not.toBe(normStreet('Am Wald'));
  });
});

describe('inArea: district hint from a listing', () => {
  const halensee = { ortsteil: 'Halensee', bezirk: 'Charlottenburg-Wilmersdorf' };
  const pberg = { ortsteil: 'Prenzlauer Berg', bezirk: 'Pankow' };
  const moabit = { ortsteil: 'Moabit', bezirk: 'Mitte' };

  it.each([
    ['Halensee (Wilmersdorf)', halensee, true],
    ['Prenzlauer Berg (Prenzlauer Berg)', pberg, true],
    ['Prenzlauer Berg (Prenzlauer Berg)', halensee, false],
    ['Moabit (Tiergarten)', moabit, true], // старый округ Tiergarten сейчас часть Mitte
    ['Wilmersdorf', halensee, true],
    ['Pankow', pberg, true],
    ['Berlin', halensee, false], // «Berlin» не сужает
    ['Weissensee', { ortsteil: 'Weißensee', bezirk: 'Pankow' }, true],
  ])('%s', (hint, cand, expected) => {
    expect(inArea(hint, cand)).toBe(expected);
  });
});
