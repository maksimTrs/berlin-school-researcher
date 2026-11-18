import type { Profile } from './extract.js';

/**
 * Staatliche Europa-Schule Berlin — двуязычные классы. Языковая пара из профиля Schulverzeichnis:
 * «…, Staatliche Europa-Schule Berlin Deutsch/Spanisch» → «Deutsch/Spanisch»; не SESB — null.
 */
export function sesbLanguages(profile: Pick<Profile, 'fields'>): string | null {
  for (const [, value] of profile.fields) {
    const m = /Staatliche Europa-Schule Berlin\s+(Deutsch\s*\/\s*[\p{L}-]+)/u.exec(value);
    if (m) return m[1].replace(/\s*\/\s*/, '/');
  }
  return null;
}
