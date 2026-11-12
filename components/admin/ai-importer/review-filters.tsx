import Link from "next/link";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import { PROBLEM_ADVANCED, PROBLEM_MAIN, STATUS_ADVANCED, STATUS_MAIN, VERIFY_ADVANCED, VERIFY_MAIN, type ChipCounts, type Filters } from "@/lib/ai-import/review-filters";

type Patch = Record<string, string | undefined>;
type Def = { label: string; hint: string };

const CHIP = "inline-flex min-h-8 items-center rounded-[var(--radius-badge)] border px-2.5 py-1 text-xs";

function Chip({ href, label, hint, active, count, kind, testId }: { href: string; label: string; hint?: string; active: boolean; count?: number; kind: "status" | "verify" | "problem"; testId: string }) {
  // Status = solid pill when active; problems = warning tone, so status and problem flags never look alike.
  const tone = kind === "problem" ? "border-[var(--color-warning)]/40 text-[var(--color-warning)]" : "border-[var(--color-border)]";
  const on = kind === "problem" ? "bg-[var(--color-warning)]/15 font-semibold" : "border-[var(--color-primary)] bg-[var(--color-primary)]/10 font-semibold text-[var(--color-primary)]";
  return (
    <Link href={href} title={hint || undefined} aria-current={active ? "true" : undefined} className={`${CHIP} ${tone} ${active ? on : "hover:bg-[var(--color-surface)]"}`} data-testid={testId}>
      {label}
      {count !== undefined && <span className="ml-1 tabular-nums opacity-80" data-testid={`count-${testId}`}>({count})</span>}
    </Link>
  );
}

function Row({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3" data-testid={testId}>
      <span className="shrink-0 pt-1.5 text-xs font-medium text-[var(--color-muted-foreground)] sm:w-28">{title}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/**
 * Review Exceptions filters: A status, B verification, C problems, D advanced (native <details>).
 * Counts are for the selected paper only (null = no paper chosen → no counts).
 */
export function ReviewFilters({ f, counts, link, issueCodes }: { f: Filters; counts: ChipCounts | null; link: (p: Patch) => string; issueCodes: string[] }) {
  const statusChips = (defs: Record<string, Def>) =>
    Object.entries(defs).map(([k, d]) => {
      const active = k === "all" ? f.status === null : f.status === k;
      return <Chip key={k} kind="status" href={link({ status: k === "exceptions" ? undefined : k })} label={d.label} hint={d.hint} active={active} count={counts?.status[k]} testId={k === "approval" ? "filter-approval" : `status-${k}`} />;
    });
  const verifyChips = (defs: Record<string, Def>) =>
    Object.entries(defs).map(([k, d]) => <Chip key={k} kind="verify" href={link({ verify: k, status: "all" })} label={d.label} hint={d.hint} active={f.verify === k} count={counts?.verify[k]} testId={`verify-${k}`} />);
  const problemChips = (defs: Record<string, Def>) =>
    Object.entries(defs).map(([k, d]) => <Chip key={k} kind="problem" href={link({ problem: k, issue: undefined, status: "all" })} label={d.label} hint={d.hint} active={f.problem === k && !f.issue} count={counts?.problem[k]} testId={`problem-${k}`} />);

  const statusDef = f.status === null ? STATUS_MAIN.all : f.status === "exceptions" ? null : (STATUS_MAIN[f.status] ?? STATUS_ADVANCED[f.status]);
  const active: { key: string; text: string; remove: Patch }[] = [
    ...(statusDef ? [{ key: "status", text: `Status: ${statusDef.label}`, remove: { status: undefined } }] : []),
    ...(f.verify ? [{ key: "verify", text: `Verification: ${(VERIFY_MAIN[f.verify] ?? VERIFY_ADVANCED[f.verify]).label}`, remove: { verify: undefined } }] : []),
    ...(f.problem && !f.issue ? [{ key: "problem", text: `Problem: ${(PROBLEM_MAIN[f.problem] ?? PROBLEM_ADVANCED[f.problem]).label}`, remove: { problem: undefined } }] : []),
    ...(f.issue ? [{ key: "issue", text: `Diagnostic: ${ISSUE_DEFS[f.issue]?.label ?? f.issue}`, remove: { issue: undefined } }] : []),
  ];
  const advancedActive = (f.status !== null && f.status in STATUS_ADVANCED) || (!!f.verify && f.verify in VERIFY_ADVANCED) || (!!f.problem && f.problem in PROBLEM_ADVANCED) || !!f.issue;
  const issues = counts ? Object.keys(ISSUE_DEFS).filter((c) => counts.issue[c]) : issueCodes;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2" data-testid="active-filters">
        <span className="text-xs text-[var(--color-muted-foreground)]">Active filters:</span>
        {active.length === 0 ? (
          <span className="text-xs">Needs review (default)</span>
        ) : (
          active.map((a) => (
            <span key={a.key} className="inline-flex items-center gap-1 rounded-[var(--radius-badge)] border border-[var(--color-border)] px-2 py-0.5 text-xs" data-testid={`active-${a.key}`}>
              {a.text}
              <Link href={link(a.remove)} aria-label={`Remove ${a.text}`} className="px-1 font-semibold hover:text-[var(--color-error)]">
                ×
              </Link>
            </span>
          ))
        )}
        {active.length > 0 && (
          <Link className="text-xs underline" href={link({ status: undefined, verify: undefined, problem: undefined, issue: undefined })} data-testid="clear-filters">
            Clear all filters
          </Link>
        )}
      </div>
      <Row title="Question status" testId="status-filters">{statusChips(STATUS_MAIN)}</Row>
      <Row title="Verification" testId="verify-filters">{verifyChips(VERIFY_MAIN)}</Row>
      <Row title="Problems" testId="problem-filters">{problemChips(PROBLEM_MAIN)}</Row>
      <p className="text-xs text-[var(--color-muted-foreground)]" data-testid="overlap-note">
        A question can have several problems, so problem counts overlap and do not add up to the number of questions.
      </p>
      <details className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3" open={advancedActive} data-testid="advanced-filters">
        <summary className="cursor-pointer text-sm font-medium">Advanced filters</summary>
        <div className="mt-3 flex flex-col gap-3">
          <Row title="Paper memory & checks">{verifyChips(VERIFY_ADVANCED)}</Row>
          <Row title="Extraction status">{statusChips(STATUS_ADVANCED)}</Row>
          <Row title="Model failures & subject checks">{problemChips(Object.fromEntries(["model-failure", "classifier-failed", "subject-mismatch", "taxonomy-disagree"].map((k) => [k, PROBLEM_ADVANCED[k]])))}</Row>
          <Row title="Re-scan candidates">{problemChips({ rescan: PROBLEM_ADVANCED.rescan })}</Row>
          <Row title="Other problem groups">{problemChips(Object.fromEntries(["structure", "answer", "answer-unverified", "reference", "ocr", "source-mismatch", "stem-options", "bilingual"].map((k) => [k, PROBLEM_ADVANCED[k]])))}</Row>
          <Row title="Technical diagnostics" testId="issue-filters">
            {issues.length === 0 ? (
              <span className="pt-1 text-xs text-[var(--color-muted-foreground)]">No diagnostics.</span>
            ) : (
              issues.map((c) => <Chip key={c} kind="problem" href={link({ issue: c })} label={ISSUE_DEFS[c]?.label ?? c} hint={c} active={f.issue === c} count={counts?.issue[c]} testId={`issue-${c}`} />)
            )}
          </Row>
        </div>
      </details>
    </div>
  );
}
