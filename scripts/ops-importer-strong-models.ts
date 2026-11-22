/**
 * Two-step importer — strong-model preflight (READ-ONLY by default) and, only with --apply, the settings change.
 *
 *   PGOPTIONS='-c default_transaction_read_only=on' DATABASE_URL=<db> AUTH_SECRET=<app secret> \
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/ops-importer-strong-models.ts [--key-check] [--apply --actor=<adminId>]
 *
 * Check (default): OpenRouter key present (never printed), catalog price + image input + text output of every
 * recommended model, the plan the PROPOSED settings would get (route / privacy / price eligibility from the stored route
 * snapshot; refresh:false — no request), each chain entry usable or why not, importer-list size. No AI request.
 * --key-check: FREE metadata call only (OpenRouter GET /key) — prints OpenRouter's limit numbers, never a key. Still no generation, nothing billed.
 * --apply: writes the proposed Import Settings (needs a writable connection and --actor). Never run without approval.
 * OpenRouter is the importer's ONLY transport (owner 2026-11-22). Options: --job-limit=<₹> (automatic checks' job-level limit), --remove=<id,id,…> (unused models: refused when any setting, chain
 * or job plan still references them, or when one is a safety model), --refresh-routes (free OpenRouter route metadata,
 * written only with --apply).
 */
import { RECOMMENDED_CHAINS, RECOMMENDED_MODEL_IDS, RECOMMENDED_PRIMARIES } from "@/lib/ai-import/chains";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const actor = process.argv.find((a) => a.startsWith("--actor="))?.slice(8) ?? "";
const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const remove = (opt("remove") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const jobLimit = opt("job-limit") !== null ? Number(opt("job-limit")) : null;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const ro = await prisma.$queryRaw<{ v: string }[]>`SELECT current_setting('default_transaction_read_only') AS v`;
  if (!apply && ro[0]?.v !== "on") throw new Error("Check mode must run on a read-only connection (PGOPTIONS='-c default_transaction_read_only=on').");
  if (apply && !actor) throw new Error("--apply needs --actor=<admin user id>.");
  const { getImporterSettings, saveImporterSettings } = await import("@/lib/ai-import/settings");
  const { MAX_IMPORTER_MODELS, normalizeImporterSettings, SELECTION_TASKS } = await import("@/lib/ai-import/config");
  const { computeModelPlan } = await import("@/lib/ai-import/select");
  const { inputImagePriceUsd } = await import("@/lib/ai-import/ai");
  const { resolveOpenRouterKey } = await import("@/lib/ai-engine/settings");

  const current = await getImporterSettings();
  const out: string[] = [];
  const bad: string[] = [];
  // Unused-model removal: dependency checks first (settings, chains, tie-break, every job's frozen plan).
  for (const id of remove) {
    if (/safety|guard|moderat/i.test(id)) bad.push(`${id} looks like a safety model — never removed`);
    if (!current.importerModels.includes(id)) bad.push(`${id} is not on the importer list`);
    if (Object.values(current.models).flat().includes(id) || Object.values(current.fallbackChains).flat().some((e) => e.model === id)) bad.push(`${id} is used by Import Settings`);
    // A job depends on a model only when its frozen plan USES it (task model or fallback); every job also stores a copy
    // of the whole importer list and the candidate rows, which are not dependencies.
    const plans = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "AiImportJob" j, jsonb_each(COALESCE(j."config"->'modelPlan'->'tasks', '{}'::jsonb)) t WHERE t.value->>'model' = ${id} OR (t.value->'fallbacks') ? ${id} OR j."config"->'verify2'->>'model' = ${id} OR j."config"->'verifyAnswers'->>'model' = ${id}`;
    const calls = await prisma.aiImportAiCall.count({ where: { model: { startsWith: id } } });
    if (Number(plans[0]?.n ?? 0) || calls) bad.push(`${id} is referenced by ${Number(plans[0]?.n ?? 0)} job(s) / ${calls} AI call(s)`);
    out.push(`Remove ${id}: job references ${Number(plans[0]?.n ?? 0)}, AI calls ${calls}`);
  }
  // Only the primaries need the importer's approval list (plans); chain-only models are priced from the catalog.
  const list = [...new Set([...current.importerModels.filter((m) => !remove.includes(m)), ...Object.values(RECOMMENDED_PRIMARIES)])];
  const proposed = normalizeImporterSettings({
    ...current,
    selection: { mode: "manual" },
    importerModels: list,
    models: { ...current.models, ...RECOMMENDED_PRIMARIES },
    fallbackChains: RECOMMENDED_CHAINS,
    workflow: { autoVerify: true, autoVerifyMaxInr: jobLimit ?? current.workflow.autoVerifyMaxInr },
  });
  out.push(`Current primaries: ${SELECTION_TASKS.map((t) => `${t}=${current.models[t] ?? "auto"}`).join(", ")} (mode ${current.selection.mode})`);
  out.push(`Proposed primaries: ${SELECTION_TASKS.map((t) => `${t}=${proposed.models[t]}`).join(", ")}`);
  out.push(`Importer model list: ${current.importerModels.length} → ${list.length} (limit ${MAX_IMPORTER_MODELS})`);
  if (list.length > MAX_IMPORTER_MODELS) bad.push(`importer list would exceed ${MAX_IMPORTER_MODELS}: remove ${list.length - MAX_IMPORTER_MODELS} unused model(s) first`);
  out.push(`Transport: OpenRouter only; automatic checks job limit: ${proposed.workflow.autoVerifyMaxInr === null ? "none" : `₹${proposed.workflow.autoVerifyMaxInr}`}`);
  out.push(`Privacy: ZDR ${current.privacy.zdr ? "REQUIRED" : "not required"}, data collection ${current.privacy.dataCollection}; paid AI ${current.aiEnabled ? "ON" : "OFF"}; auto checks ${current.workflow.autoVerify ? "ON" : "OFF"}${current.workflow.autoVerifyMaxInr !== null ? ` (limit ₹${current.workflow.autoVerifyMaxInr})` : ""}`);

  // Keys: presence only (decrypted in memory, never printed).
  const keys = { openrouter: await resolveOpenRouterKey() };
  out.push(`Key OpenRouter: ${keys.openrouter ? "present" : "MISSING / disabled"}`);

  // Catalog facts of every model.
  const rows = new Map((await prisma.aiModel.findMany({ where: { id: { in: RECOMMENDED_MODEL_IDS } } })).map((m) => [m.id, m]));
  for (const id of RECOMMENDED_MODEL_IDS) {
    const m = rows.get(id);
    if (!m) {
      bad.push(`${id} not in the catalog`);
      continue;
    }
    const img = inputImagePriceUsd(m);
    const ok = m.promptPrice !== null && m.completionPrice !== null && m.inputModalities.includes("image") && img !== null && m.outputModalities.includes("text") && !m.disabled && !m.missingSince;
    if (!ok) bad.push(`${id}: catalog not usable (price / image input / text output / listed)`);
    out.push(`Catalog ${id}: $${((m.promptPrice ?? 0) * 1e6).toFixed(2)}/$${((m.completionPrice ?? 0) * 1e6).toFixed(2)} per M, image ${m.inputModalities.includes("image") ? "yes" : "NO"}, ${ok ? "usable" : "NOT usable"}`);
  }

  // Routes: --refresh-routes reads OpenRouter's FREE public route metadata for the proposed list (written with --apply).
  let snapshot;
  if (args.has("--refresh-routes")) {
    const { readRoutes, storeRouteSnapshot } = await import("@/lib/ai-import/routes");
    snapshot = await readRoutes(proposed.importerModels);
    out.push(`Routes read for ${proposed.importerModels.length} model(s) (free metadata)${apply ? "; stored" : "; not stored (check mode)"}`);
    if (apply) await storeRouteSnapshot(snapshot);
  }
  // The plan the proposed settings get (route snapshot; no AI request).
  const plan = await computeModelPlan(proposed, { refresh: false, ...(snapshot ? { snapshot } : {}) });
  for (const t of SELECTION_TASKS) {
    const c = plan.tasks[t];
    const eligible = c.model === proposed.models[t];
    if (!eligible) bad.push(`${t}: primary ${proposed.models[t]} not eligible — ${c.reason.slice(0, 200)}`);
    out.push(`Plan ${t}: ${c.model ?? "none"}${eligible ? "" : ` (WANTED ${proposed.models[t]})`}, up to ₹${c.maxInr?.toFixed(2) ?? "?"} per request — ${c.reason.slice(0, 140)}`);
  }
  if (plan.problems.length) out.push(`Plan problems: ${plan.problems.join(" | ").slice(0, 400)}`);
  if (plan.tasks.extract.model && plan.tasks.extract.model.split("/")[0] === plan.tasks.verify.model?.split("/")[0]) bad.push("reading and verification share a vendor");

  // Chains: every entry is a catalog model through OpenRouter; reading and verification never share a vendor.
  for (const [role, entries] of Object.entries(RECOMMENDED_CHAINS)) {
    const other = role === "verify" ? proposed.models.extract : role === "extract" ? proposed.models.verify : null;
    const parts = entries.map((e) => `${e.model}${other && e.model.split("/")[0] === other.split("/")[0] ? " [skipped: same vendor as the other role]" : ""}`);
    if (parts.every((p) => p.includes("skipped"))) bad.push(`${role}: no usable fallback`);
    out.push(`Chain ${role}: ${parts.join(" → ")}`);
  }

  if (args.has("--key-check")) {
    const { getKeyInfo } = await import("@/lib/ai-engine/openrouter");
    const free = async (name: string, f: () => Promise<string>) => out.push(`Free check ${name}: ${await f().catch((e) => `FAILED (${e instanceof Error ? e.message.replace(/sk-[\w-]+|AIza[\w-]+/g, "***").slice(0, 120) : "error"})`)}`);
    if (keys.openrouter) await free("OpenRouter key", async () => { const k = await getKeyInfo(keys.openrouter!); return `limit ${k.limit ?? "none"}, remaining ${k.limit_remaining ?? "?"}, usage ${k.usage ?? "?"} (USD)`; });
  }

  console.log(out.join("\n"));
  console.log(bad.length ? `\nBLOCKERS (${bad.length}):\n- ${bad.join("\n- ")}` : "\nNo blockers.");
  if (apply) {
    if (bad.length) throw new Error("Not applied: fix the blockers first.");
    await saveImporterSettings(proposed, actor);
    console.log("APPLIED.");
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
