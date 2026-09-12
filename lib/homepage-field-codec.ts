/**
 * Converts between the structured JSON stored per homepage section field and
 * a plain-text textarea representation admins edit directly — no code
 * editing required (Section 21), while keeping the DB shape simple JSON.
 */

export interface StatMetric {
  label: string;
  source: "DYNAMIC" | "ADMIN_CONFIGURED";
  dynamicKey?: "examsActive" | "previousYearPapers" | "testSeriesCount";
  manualValue?: string;
}

export function pairListToText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((pair) => (Array.isArray(pair) ? `${pair[0] ?? ""} | ${pair[1] ?? ""}` : "")).join("\n");
}

export function textToPairList(text: string): [string, string][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [a, ...rest] = line.split("|");
      return [a.trim(), rest.join("|").trim()] as [string, string];
    });
}

export function listToText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.join("\n");
}

export function textToList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function statisticsToText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as StatMetric[])
    .map((m) => `${m.label} | ${m.source === "DYNAMIC" ? `DYNAMIC:${m.dynamicKey}` : `ADMIN:${m.manualValue}`}`)
    .join("\n");
}

export function textToStatistics(text: string): StatMetric[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, sourcePart] = line.split("|").map((p) => p.trim());
      if (sourcePart?.startsWith("DYNAMIC:")) {
        return {
          label,
          source: "DYNAMIC" as const,
          dynamicKey: sourcePart.replace("DYNAMIC:", "").trim() as StatMetric["dynamicKey"],
        };
      }
      return { label, source: "ADMIN_CONFIGURED" as const, manualValue: sourcePart?.replace("ADMIN:", "").trim() ?? "" };
    });
}

export function idListToText(ids: unknown, options: { id: string; name: string }[]): string {
  if (!Array.isArray(ids)) return "";
  const byId = new Map(options.map((o) => [o.id, o.name]));
  return ids.map((id) => byId.get(id) ?? id).join(", ");
}
