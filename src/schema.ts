import { z } from 'zod';
import { config } from './config.js';

export const AddressQuery = z.object({
  raw: z.string().optional(),
  street: z.string().min(2),
  house: z.number().int().positive(),
  suffix: z.string().regex(/^[a-zA-Z]$/).nullish(),
  plz: z.string().regex(/^\d{5}$/).nullish(),
  ortsteil: z.string().nullish(),
});
export type AddressQuery = z.infer<typeof AddressQuery>;

// номер дома скрыт в объявлении — известны только PLZ и/или район (Ortsteil) и, может быть, улица
export const PlzQuery = z
  .object({
    plz: z.string().regex(/^\d{5}$/, 'PLZ — 5 цифр').nullish(),
    ortsteil: z.string().min(3).nullish(), // как ort_name в adressen_berlin: «Friedenau», «Wilmersdorf»
    street: z.string().min(2).nullish(),
  })
  .refine((q) => q.plz || q.ortsteil, 'Нужен PLZ или район (Ortsteil)');
export type PlzQuery = z.infer<typeof PlzQuery>;

// адрес строкой, как в объявлении, — раскладывает parseAddress (покрыт тестами), а не модель
const RawAddress = z.object({ raw: z.string().min(3) }).strict().transform((a, ctx) => {
  try {
    return parseAddress(a.raw);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

export const Input = z.object({
  addresses: z.array(z.union([AddressQuery, RawAddress])).min(1).max(config.maxAddresses),
});

/** «Ruppiner Straße 47, 10115» / «Esmarchstraße 13, 10407 Prenzlauer Berg (Prenzlauer Berg)» → AddressQuery. */
export function parseAddress(raw: string): AddressQuery {
  // номер дома — первое число, после которого идёт только [буква][-диапазон], затем PLZ и Ortsteil без цифр:
  // так «Straße des 17. Juni 100» даёт дом 100, а «Joachim-Friedrich-Straße 35-36, 10711» — дом 35
  const m = raw
    .trim()
    .replace(/^Adresse:\s*/i, '') // так начинается адрес в карточке объявления
    .match(/^(.+?)\s+(?:Nr\.?\s*)?(\d{1,4})\s*([a-zA-Z])?(?:\s*[-–/]\s*\d+[a-zA-Z]?)?(?:\s*,\s*|\s+|$)(\d{5})?[\s,]*([^\d]*)$/);
  if (!m) throw new Error(`Не разобран адрес: «${raw}». Ожидается «Straße Nr[, PLZ] [Ortsteil]»`);
  return AddressQuery.parse({
    raw,
    street: m[1].replace(/,$/, ''),
    house: Number(m[2]),
    suffix: m[3] ?? null,
    plz: m[4] ?? null,
    // «10711 Berlin, Halensee (Wilmersdorf)» / «10711 Berlin - Halensee» → «Halensee (Wilmersdorf)» / «Halensee»
    ortsteil: m[5].replace(/^Berlin\b[\s,–-]*/i, '').trim() || null,
  });
}
