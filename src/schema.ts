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

export const Input = z.object({
  addresses: z.array(AddressQuery).min(1).max(config.maxAddresses),
});

/** «Ruppiner Straße 47, 10115» / «Beusselstraße 44F 10553 Moabit» → AddressQuery. Свободный текст разбирает skill. */
export function parseAddress(raw: string): AddressQuery {
  const m = raw.trim().match(/^(.+?)\s+(\d+)\s*([a-zA-Z])?(?![a-zA-Z])[\s,]*(\d{5})?[\s,]*(.*)$/);
  if (!m) throw new Error(`Не разобран адрес: «${raw}». Ожидается «Straße Nr[, PLZ] [Ortsteil]»`);
  return AddressQuery.parse({
    raw,
    street: m[1].replace(/,$/, ''),
    house: Number(m[2]),
    suffix: m[3] ?? null,
    plz: m[4] ?? null,
    ortsteil: m[5] || null,
  });
}
