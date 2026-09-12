/**
 * Defensive readers for section.content — admin-authored freeform JSON.
 * A malformed field (e.g. from a future content-model change) degrades to
 * an empty/blank value instead of crashing the public page.
 */
export function str(content: Record<string, unknown>, key: string, fallback = ""): string {
  const value = content[key];
  return typeof value === "string" ? value : fallback;
}

export function pairs(content: Record<string, unknown>, key: string): [string, string][] {
  const value = content[key];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (pair): pair is [string, string] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
  );
}

export function list(content: Record<string, unknown>, key: string): string[] {
  const value = content[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
