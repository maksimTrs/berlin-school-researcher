import { describe, expect, it } from 'vitest';
import { sesbLanguages } from '../../src/sesb.js';

const offers = (value: string) => ({ fields: [['Предложения (Ganztag, профиль)', value]] as [string, string][] });

describe('SESB', () => {
  it('language pair from the Schulverzeichnis offers field', () => {
    expect(sesbLanguages(offers('Gebundener Ganztagbetrieb (GGB), Staatliche Europa-Schule Berlin Deutsch/Französisch'))).toBe('Deutsch/Französisch');
    expect(sesbLanguages(offers('Staatliche Europa-Schule Berlin Deutsch / Spanisch, Schulanfangsphase'))).toBe('Deutsch/Spanisch');
    expect(sesbLanguages(offers('Offene Ganztagbetreuung (OGB), Schulanfangsphase mit jahrgangsbezogenen Lerngruppen'))).toBeNull();
    expect(sesbLanguages({ fields: [] })).toBeNull();
  });
});
