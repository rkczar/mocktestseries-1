import "server-only";
import { prisma } from "@/lib/prisma";
import { scanForSecrets } from "@/lib/system-report";

/**
 * Separate, privileged Student Data Report (Admin -> Backup & Disaster
 * Recovery). Deliberately its own file/query, never merged into the
 * architecture-focused Live System Report — this is a per-student export,
 * gated MASTER_ADMIN-only by the route handler, never a disaster-recovery
 * backup. Never selects passwordHash, OTP secrets, or session tokens; email
 * and mobile are only selected when the caller explicitly opts in.
 */

const MAX_STUDENTS = 20_000;

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function fmtDateIst(date: Date | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(date);
}

export interface StudentDataReportOptions {
  includeContact: boolean;
}

export async function generateStudentDataReport(
  opts: StudentDataReportOptions
): Promise<{ markdown: string; generatedAt: Date; truncated: boolean; count: number }> {
  const generatedAt = new Date();
  const totalStudents = await prisma.student.count();

  const students = await prisma.student.findMany({
    select: {
      studentId: true,
      name: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
      email: opts.includeContact,
      mobile: opts.includeContact,
      examEnrollments: { select: { exam: { select: { name: true } } } },
      _count: { select: { testAttempts: true, answers: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_STUDENTS,
  });

  const truncated = totalStudents > students.length;

  const lines: string[] = [];
  lines.push("# MockTestSeries.in — Student Data Report", "");
  lines.push(`Generated: ${generatedAt.toISOString()}`);
  lines.push(`MASTER_ADMIN-only privileged export. Contact information ${opts.includeContact ? "INCLUDED" : "excluded"}.`);
  lines.push(`Total students in database: ${totalStudents}. Rows in this export: ${students.length}${truncated ? " (truncated — export capped at " + MAX_STUDENTS + " rows)" : ""}.`);
  lines.push("", "Never exported: password, password hash, OTP secret, session token, OAuth token.", "");

  const headerCols = ["Internal Student ID", "Name", "Status", "Registered", "Enrolled Exam(s)", "Attempts", "Answers", "Last Active"];
  if (opts.includeContact) headerCols.push("Email", "Mobile");
  lines.push(`| ${headerCols.join(" | ")} |`);
  lines.push(`|${headerCols.map(() => "---").join("|")}|`);

  for (const s of students) {
    const exams = s.examEnrollments.map((e) => e.exam.name).join(", ");
    const row = [
      cell(s.studentId),
      cell(s.name),
      cell(s.status),
      fmtDateIst(s.createdAt),
      cell(exams || "none"),
      cell(s._count.testAttempts),
      cell(s._count.answers),
      s.lastLoginAt ? fmtDateIst(s.lastLoginAt) : "never",
    ];
    if (opts.includeContact) {
      row.push(cell(s.email), cell(s.mobile));
    }
    lines.push(`| ${row.join(" | ")} |`);
  }

  const markdown = lines.join("\n");
  const hits = scanForSecrets(markdown);
  if (hits.length > 0) {
    throw new Error("Student data report generation aborted: content matched a secret-shaped pattern and was not returned.");
  }

  return { markdown, generatedAt, truncated, count: students.length };
}

export function studentDataReportFilename(generatedAt: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(generatedAt);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `mocktestseries-student-data-report-${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}.md`;
}
