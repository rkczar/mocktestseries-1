"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DiagramIssue } from "@/lib/diagram-issues";
import styles from "./graph-view.module.css";

/** Section 7 — "Issues & Disconnections". Every row focuses/highlights its node in the canvas on click. */
export function IssuesPanel({ issues, onFocus }: { issues: DiagramIssue[]; onFocus: (nodeId: string) => void }) {
  if (issues.length === 0) {
    return (
      <div className={styles.issuesEmpty}>
        <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" aria-hidden />
        Nothing to report — every page and connection checks out.
      </div>
    );
  }

  return (
    <div className={styles.issuesList}>
      {issues.map((issue) => (
        <button key={issue.id} type="button" className={styles.issueRow} onClick={() => onFocus(issue.nodeId)}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" aria-hidden />
          <span className={styles.issueBody}>
            <span className={styles.issueTitle}>{issue.title}</span>
            <span className={styles.issueDetail}>{issue.detail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
