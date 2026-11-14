import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectNative } from "@/components/ui/select-native";
import { PAGE_SIZES, loadExamEnrollmentCounts, loadStudentList, type StudentListParams, type StudentListScope } from "@/lib/admin-students-list";
import { displayExamName } from "@/lib/exam-display";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { DeleteStudentDialog } from "./delete-student-dialog";

/**
 * Teacher Portal reuse: the same list, scoped to the teacher's exams, linking
 * to /teacher/students and never showing contact details or access labels.
 */
export interface StudentsPanelTeacherView {
  scope: StudentListScope;
  basePath: string;
}

const STATUS_VARIANT = {
  ACTIVE: "success",
  SUSPENDED: "warning",
  DELETION_REQUESTED: "warning",
  DELETED: "error",
} as const;

const ACCESS_VARIANT = { PREMIUM: "success", TRIAL: "info", FREE: "neutral" } as const;

const fmtDate = (d: Date) => d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" });

function hrefFor(p: StudentListParams, patch: Partial<StudentListParams>, basePath?: string) {
  const n = { ...p, ...patch };
  const sp = new URLSearchParams(basePath ? {} : { tab: "all" });
  if (n.q) sp.set("q", n.q);
  if (n.account !== "all") sp.set("account", n.account);
  if (n.access !== "all") sp.set("access", n.access);
  if (n.sort !== "newest") sp.set("sort", n.sort);
  if (n.perPage !== 50) sp.set("per", String(n.perPage));
  if (n.exam) sp.set("exam", n.exam);
  if (n.from) sp.set("from", n.from);
  if (n.to) sp.set("to", n.to);
  if (n.page > 1) sp.set("page", String(n.page));
  return `${basePath ?? "/admin/students"}?${sp.toString()}`;
}

/** Page numbers to show: first, last, and a window around the current page. */
function pageWindow(page: number, pageCount: number): (number | "…")[] {
  const set = new Set([1, pageCount, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pageCount));
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push("…");
    out.push(n);
  });
  return out;
}

export async function AllStudentsPanel({ params, teacher }: { params: StudentListParams; teacher?: StudentsPanelTeacherView }) {
  // Approved deletions leave an anonymized "Deleted Student" row behind for
  // retained attempt/payment history; it is not an active student. Who it
  // was lives in the deletion audit record (Deletion Requests tab).
  const [{ total, filtered, page, pageCount, perPage, rows }, examCounts, canDelete] = await Promise.all([
    loadStudentList(params, undefined, teacher?.scope),
    teacher ? null : loadExamEnrollmentCounts(),
    teacher ? false : hasPermission(PERMISSIONS.STUDENT_DELETION_MANAGE),
  ]);
  const p = { ...params, page };
  const base = teacher?.basePath;
  const href = (q: StudentListParams, patch: Partial<StudentListParams>) => hrefFor(q, patch, base);
  const from = filtered === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, filtered);
  const filtering = Boolean(params.q || params.exam || params.from || params.to) || params.account !== "all" || params.access !== "all";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Students</CardTitle>
        <CardDescription data-testid="students-counts">
          {total.toLocaleString("en-IN")} {teacher ? "student" : "registered student"}{total === 1 ? "" : "s"}
          {filtering ? ` · ${filtered.toLocaleString("en-IN")} match the filters` : ""}
          {teacher ? " in your exams" : " · deleted accounts are listed under Deleted Students"}
        </CardDescription>
        {examCounts ? (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted-foreground)]" data-testid="students-exam-counts">
            {examCounts.exams.map((e) => (
              <Link key={e.id} href={href(params, { exam: e.id, page: 1 })} className="hover:underline" data-exam-id={e.id}>
                {displayExamName(e.name)}: <span className="font-semibold text-[var(--color-foreground)]">{e.students.toLocaleString("en-IN")}</span>
              </Link>
            ))}
            <Link href={href(params, { exam: "none", page: 1 })} className="hover:underline">
              No exam selected: <span className="font-semibold text-[var(--color-foreground)]">{examCounts.noExam.toLocaleString("en-IN")}</span>
            </Link>
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form method="get" action={base ?? "/admin/students"} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6" data-testid="students-filters">
          {teacher ? null : <input type="hidden" name="tab" value="all" />}
          <Input
            name="q"
            defaultValue={params.q}
            placeholder={teacher ? "Search Student ID or name" : "Search Student ID, name, email or mobile"}
            aria-label="Search students"
            className="sm:col-span-2"
          />
          {examCounts ? (
            <SelectNative name="exam" defaultValue={params.exam} aria-label="Exam">
              <option value="">All exams</option>
              {examCounts.exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {displayExamName(e.name)}
                  {e.isActive ? "" : " (inactive)"} ({e.students})
                </option>
              ))}
              <option value="none">No exam selected ({examCounts.noExam})</option>
            </SelectNative>
          ) : null}
          {examCounts ? (
            <div className="flex gap-2 sm:col-span-2">
              <Input type="date" name="from" defaultValue={params.from} aria-label="Registered from" title="Registered from" />
              <Input type="date" name="to" defaultValue={params.to} aria-label="Registered to" title="Registered to" />
            </div>
          ) : null}
          <SelectNative name="account" defaultValue={params.account} aria-label="Account status">
            <option value="all">All accounts</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive (suspended / deletion requested)</option>
          </SelectNative>
          {teacher ? null : (
          <SelectNative name="access" defaultValue={params.access} aria-label="Access">
            <option value="all">All access</option>
            <option value="premium">Premium</option>
            <option value="trial">Trial</option>
            <option value="free">Free</option>
          </SelectNative>
          )}
          <SelectNative name="sort" defaultValue={params.sort} aria-label="Sort">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </SelectNative>
          <div className="flex gap-2">
            <SelectNative name="per" defaultValue={String(perPage)} aria-label="Students per page">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </SelectNative>
            <Button type="submit" size="default">
              Apply
            </Button>
          </div>
        </form>
        {filtering ? (
          <Link href={href(params, { q: "", account: "all", access: "all", exam: "", from: "", to: "", page: 1 })} className="w-fit text-xs text-[var(--color-primary)] hover:underline">
            Clear filters
          </Link>
        ) : null}

        <div className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              {total === 0 ? "No students have registered yet." : "No students match these filters."}
            </p>
          ) : (
            <table className="w-full min-w-[860px] text-left text-sm" data-testid="students-table">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Student ID</th>
                  <th className="py-2 pr-4">Name</th>
                  {teacher ? null : <th className="py-2 pr-4">Email / Mobile</th>}
                  {teacher ? null : <th className="py-2 pr-4">Exams</th>}
                  <th className="py-2 pr-4">Registered</th>
                  <th className="py-2 pr-4">Last Activity</th>
                  <th className="py-2 pr-4">Attempts</th>
                  {teacher ? null : <th className="py-2 pr-4">Access</th>}
                  <th className="py-2 pr-4">Status</th>
                  {canDelete ? <th className="py-2 pr-4">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-muted-foreground)]">
                      <Link href={`${base ?? "/admin/students"}/${s.id}`} className="text-[var(--color-primary)] hover:underline">
                        {s.studentId}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{s.name}</td>
                    {teacher ? null : (
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {s.email ?? s.mobile ?? "—"}
                      {s.email && s.mobile ? <span className="block text-xs">{s.mobile}</span> : null}
                    </td>
                    )}
                    {teacher ? null : (
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]" data-testid="student-exams">
                      {s.examEnrollments.length ? s.examEnrollments.map((e) => displayExamName(e.exam.name)).join(", ") : "—"}
                    </td>
                    )}
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{fmtDate(s.createdAt)}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{s.lastActivity ? fmtDate(s.lastActivity) : "Never"}</td>
                    <td className="py-2.5 pr-4">{s._count.testAttempts}</td>
                    {teacher || !s.access ? null : (
                    <td className="py-2.5 pr-4">
                      <Badge variant={ACCESS_VARIANT[s.access]}>{s.access}</Badge>
                    </td>
                    )}
                    <td className="py-2.5 pr-4">
                      <Badge variant={STATUS_VARIANT[s.status]}>{s.status.replace(/_/g, " ")}</Badge>
                    </td>
                    {canDelete ? (
                      <td className="py-2.5 pr-4">
                        <DeleteStudentDialog studentDbId={s.id} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <nav className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-label="Students pagination" data-testid="students-pagination">
          <p className="text-[var(--color-muted-foreground)]">
            Showing {from.toLocaleString("en-IN")}–{to.toLocaleString("en-IN")} of {filtered.toLocaleString("en-IN")} · Page {page} of {pageCount}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            {page > 1 ? (
              <Link href={href(p, { page: page - 1 })} className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-surface)]" rel="prev">
                Previous
              </Link>
            ) : (
              <span className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 opacity-40">Previous</span>
            )}
            {pageWindow(page, pageCount).map((n, i) =>
              n === "…" ? (
                <span key={`gap-${i}`} className="px-1 text-[var(--color-muted-foreground)]">
                  …
                </span>
              ) : (
                <Link
                  key={n}
                  href={href(p, { page: n })}
                  aria-current={n === page ? "page" : undefined}
                  className={`min-w-9 rounded-[var(--radius-button)] border px-2.5 py-1.5 text-center ${
                    n === page ? "border-[var(--color-primary)] font-semibold text-[var(--color-primary)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface)]"
                  }`}
                >
                  {n}
                </Link>
              )
            )}
            {page < pageCount ? (
              <Link href={href(p, { page: page + 1 })} className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-surface)]" rel="next">
                Next
              </Link>
            ) : (
              <span className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 opacity-40">Next</span>
            )}
          </div>
        </nav>
      </CardContent>
    </Card>
  );
}
