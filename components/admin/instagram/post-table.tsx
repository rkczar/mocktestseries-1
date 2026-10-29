import { Send } from "lucide-react";
import { OpenInEditor } from "@/components/admin/instagram/editor-host";
import { InstagramStatusBadge } from "@/components/admin/instagram/status-badge";
import type { PostListRow } from "@/lib/instagram/queries";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Post list for Create Post / Drafts / History. Must be rendered inside <EditorHost>. */
export function PostTable({ rows, empty, testId, showPublished = false, showPublish = false }: { rows: PostListRow[]; empty: string; testId: string; showPublished?: boolean; showPublish?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-2 pr-3">Question / Topic</th>
            <th className="py-2 pr-3">Series</th>
            <th className="py-2 pr-3">Exam / Paper</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">{showPublished ? "Posted" : "Updated"}</th>
            {showPublish ? <th className="py-2 pr-3" /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[var(--color-border)] align-top" data-row={r.questionCode}>
              <td className="max-w-md py-2 pr-3">
                <OpenInEditor target={{ questionId: r.questionId ?? "", topicKey: r.topicKey ?? undefined, code: r.questionCode, preview: r.preview, series: r.series }} className="hover:underline" testId="open-question">
                  <span className="block font-mono text-xs text-[var(--color-muted-foreground)]">{`${r.questionCode} · v${r.version}${r.isCurrent ? "" : " (superseded)"}`}</span>
                  {r.preview}
                </OpenInEditor>
              </td>
              <td className="py-2 pr-3">{r.series === "PYQ" ? "PYQ Series" : r.series === "TOPIC" ? "Topic" : "Most Missed"}</td>
              <td className="py-2 pr-3">
                <div>{r.examName}</div>
                {r.paperLabel ? <div className="text-xs text-[var(--color-muted-foreground)]">{r.paperLabel}</div> : null}
              </td>
              <td className="py-2 pr-3">
                <InstagramStatusBadge status={r.status} />
              </td>
              <td className="py-2 pr-3 text-xs text-[var(--color-muted-foreground)]">
                {showPublished ? (r.publishedAt ? fmt(r.publishedAt) : "—") : fmt(r.updatedAt)}
                {showPublished && r.igPermalink ? (
                  <a className="ml-2 underline" href={r.igPermalink} target="_blank" rel="noreferrer">
                    View
                  </a>
                ) : null}
              </td>
              {showPublish ? (
                <td className="py-2 pr-3">
                  {r.isCurrent && (r.status === "DRAFT" || r.status === "FAILED") ? (
                    <OpenInEditor
                      target={{ questionId: r.questionId ?? "", topicKey: r.topicKey ?? undefined, code: r.questionCode, preview: r.preview, series: r.series, publish: true }}
                      className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-[var(--radius-button)] bg-[var(--color-success)] px-3 text-xs font-semibold text-white"
                      testId="row-publish"
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden /> Publish to Instagram
                    </OpenInEditor>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={showPublish ? 6 : 5} className="py-6 text-center text-[var(--color-muted-foreground)]">
                {empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
