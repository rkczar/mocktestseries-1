import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Index of the typeset Previous Year Paper PDFs per exam (no schema change): Setting
 * `exam.paperPdfs.<examId>` = { entries: PaperPdfEntry[] }. One current entry per (paper, language);
 * a rebuild replaces the entry and leaves the older TestResource (inactive) for rollback.
 * Built offline by scripts/build-paper-pdfs.ts; served only by /api/student/paper-download.
 */

export const PAPER_PDF_LANGS = ["BILINGUAL", "ENGLISH", "HINDI"] as const;
export type PaperPdfLang = (typeof PAPER_PDF_LANGS)[number];

export const PAPER_PDF_LANG_LABEL: Record<PaperPdfLang, string> = { BILINGUAL: "Hindi + English", ENGLISH: "English", HINDI: "हिंदी (Hindi)" };

export interface PaperPdfEntry {
  paperId: string;
  year: number;
  lang: PaperPdfLang;
  resourceId: string;
  sha256: string;
  pages: number;
  questionCount: number;
  builtAt: string;
}

export const paperPdfIndexKey = (examId: string) => `exam.paperPdfs.${examId}`;

export function isPaperPdfLang(v: unknown): v is PaperPdfLang {
  return typeof v === "string" && (PAPER_PDF_LANGS as readonly string[]).includes(v);
}

export async function getPaperPdfIndex(examId: string): Promise<PaperPdfEntry[]> {
  const row = await prisma.setting.findUnique({ where: { key: paperPdfIndexKey(examId) } });
  const entries = (row?.value as { entries?: unknown } | null)?.entries;
  return Array.isArray(entries) ? (entries as PaperPdfEntry[]) : [];
}

export async function upsertPaperPdfEntry(examId: string, entry: PaperPdfEntry): Promise<void> {
  const entries = (await getPaperPdfIndex(examId)).filter((e) => !(e.paperId === entry.paperId && e.lang === entry.lang));
  const value = { entries: [...entries, entry] } as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({ where: { key: paperPdfIndexKey(examId) }, create: { key: paperPdfIndexKey(examId), value }, update: { value } });
}
