import { ENGINE_FEATURE_MAP } from "@/lib/ai-engine/config";
import { istStartOfDay, parseIstDateTimeLocal, toIstDateString } from "@/lib/ist-time";

/** Validated filter values from AI Analytics / History query strings (IST calendar days, inclusive). */
export function parseRange(sp: Record<string, string | undefined>, defaultDays: number) {
  const today = toIstDateString(new Date());
  const valid = (d: string | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  const toDay = valid(sp.to) ?? today;
  const fromDay = valid(sp.from) ?? toIstDateString(new Date(istStartOfDay(new Date()).getTime() - (defaultDays - 1) * 86_400_000));
  const from = parseIstDateTimeLocal(`${fromDay}T00:00`)!;
  const to = new Date(parseIstDateTimeLocal(`${toDay}T00:00`)!.getTime() + 86_400_000);
  const feature = sp.feature && ENGINE_FEATURE_MAP[sp.feature as keyof typeof ENGINE_FEATURE_MAP] ? sp.feature : null;
  const model = sp.model && /^[A-Za-z0-9._:\/-]{1,120}$/.test(sp.model) ? sp.model : null;
  const provider = sp.provider && /^(openrouter|gemini|openai|anthropic|default)$/.test(sp.provider) ? sp.provider : null;
  const status = sp.status === "ok" || sp.status === "failed" ? sp.status : null;
  return { fromDay, toDay, from, to, feature, model, provider, status } as const;
}
