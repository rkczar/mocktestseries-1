import type { Metadata } from "next";
import { Download } from "lucide-react";

import { prisma } from "@/lib/db";

import { ImportClient } from "./ImportClient";

export const metadata: Metadata = { title: "Bulk Import Questions · Admin" };

export default async function ImportQuestionsPage() {
  const exams = await prisma.exam.findMany({ orderBy: { title: "asc" }, select: { id: true, title: true } });

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[26px] font-bold text-text-heading">Bulk import questions</h1>
          <p className="mt-1 max-w-xl text-sm text-text-muted">
            Upload a CSV or XLSX file, review the valid/duplicate/invalid split, then confirm.
            Nothing is written to the database until you confirm.
          </p>
        </div>
        <a
          href="/api/admin/questions/template"
          className="inline-flex items-center gap-1.5 rounded-[9px] border border-border-strong px-4 py-2.5 text-sm font-bold text-primary hover:bg-accent"
        >
          <Download className="size-4" /> Download CSV template
        </a>
      </div>

      <div className="mt-6">
        <ImportClient exams={exams} />
      </div>
    </div>
  );
}
