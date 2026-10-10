import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { TEMPLATE_KEYS, normalizeOverrides, type DesignOverrides, type TemplateKey } from "@/lib/instagram/types";

/**
 * Saved design presets (Admin → Instagram → Design Mode): a template plus
 * colour/font overrides and text scales, stored in the `instagram.designPresets`
 * Setting. Applying a preset copies these values into a post's design, so a
 * later preset edit never changes posts that already used it.
 */

export const PRESETS_SETTING_KEY = "instagram.designPresets";
export const MAX_PRESETS = 20;

export interface DesignPreset {
  id: string;
  name: string;
  template: TemplateKey;
  overrides?: DesignOverrides;
  questionScale: number;
  bodyScale: number;
  createdAt: string;
}

const clamp = (n: unknown) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 1;
  return Math.round(Math.min(1.25, Math.max(0.85, v)) * 100) / 100;
};

function normalize(raw: unknown): DesignPreset | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string" || !(TEMPLATE_KEYS as readonly string[]).includes(r.template as string)) return null;
  const overrides = normalizeOverrides(r.overrides);
  return {
    id: r.id,
    name: r.name.slice(0, 40),
    template: r.template as TemplateKey,
    ...(overrides ? { overrides } : {}),
    questionScale: clamp(r.questionScale),
    bodyScale: clamp(r.bodyScale),
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
  };
}

export async function listPresets(): Promise<DesignPreset[]> {
  const row = await prisma.setting.findUnique({ where: { key: PRESETS_SETTING_KEY } });
  const list = Array.isArray((row?.value as { presets?: unknown } | undefined)?.presets) ? ((row!.value as { presets: unknown[] }).presets ?? []) : [];
  return list.map(normalize).filter((p): p is DesignPreset => p !== null);
}

async function write(presets: DesignPreset[]) {
  const value = { presets, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key: PRESETS_SETTING_KEY }, update: { value: value as object }, create: { key: PRESETS_SETTING_KEY, value: value as object } });
}

export async function savePreset(input: { name: string; template: string; overrides?: unknown; questionScale?: number; bodyScale?: number }): Promise<DesignPreset> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) throw new Error("Preset name: 1–40 characters.");
  const preset = normalize({ id: crypto.randomUUID(), name, template: input.template, overrides: input.overrides, questionScale: input.questionScale, bodyScale: input.bodyScale, createdAt: new Date().toISOString() });
  if (!preset) throw new Error("Invalid template.");
  const list = await listPresets();
  const rest = list.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  if (rest.length >= MAX_PRESETS) throw new Error(`At most ${MAX_PRESETS} presets — delete one first.`);
  await write([...rest, preset]);
  return preset;
}

export async function deletePreset(id: string): Promise<void> {
  await write((await listPresets()).filter((p) => p.id !== id));
}
