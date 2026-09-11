/**
 * Derives a compact exam short-code from its slug for question-code generation, e.g.
 * "ruhs-medical-officer-2026" -> "RUHS-MO". First segment is kept whole if it reads like an
 * acronym (<=5 letters), otherwise just its initial; every other alphabetic segment contributes
 * its initial. Numeric segments (a trailing year, typically) are dropped.
 */
export function examShortCode(slug: string) {
  const segments = slug.split("-").filter((s) => /[a-z]/i.test(s));
  if (segments.length === 0) return "EXAM";

  const [first, ...rest] = segments;
  const head = first.length <= 5 ? first.toUpperCase() : first[0].toUpperCase();
  const tail = rest.map((s) => s[0].toUpperCase()).join("");

  return tail ? `${head}-${tail}` : head;
}
