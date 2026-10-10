import { ExternalLink } from "lucide-react";
import { OpenInEditor } from "@/components/admin/instagram/editor-host";
import { InstagramStatusBadge } from "@/components/admin/instagram/status-badge";
import type { PostListRow } from "@/lib/instagram/queries";

const fmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) + " IST";

/** Published History table: preview, question, exam/year, date, Media ID, permalink, status. Must be rendered inside <EditorHost>. */
export function PublishedTable({ rows, empty, testId }: { rows: PostListRow[]; empty: string; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid={testId}>
        <thead className="text-left text-xs text-[var(--color-muted-foreground)]">
          <tr>
            <th className="py-2 pr-3">Preview</th>
            <th className="py-2 pr-3">Question</th>
            <th className="py-2 pr-3">Exam / PYQ year</th>
            <th className="py-2 pr-3">Published</th>
            <th className="py-2 pr-3">Instagram</th>
            <th className="py-2 pr-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[var(--color-border)] align-top" data-row={r.questionCode} data-post-id={r.id}>
              <td className="py-2 pr-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/admin/instagram/slide?postId=${r.id}&i=0`} alt={`${r.questionCode} slide 1`} loading="lazy" className="h-20 w-16 rounded border border-[var(--color-border)] object-cover" />
              </td>
              <td className="max-w-xs py-2 pr-3">
                <OpenInEditor target={{ questionId: r.questionId, code: r.questionCode, preview: r.preview, series: r.series }} className="hover:underline" testId="open-question">
                  <span className="block font-mono text-xs text-[var(--color-muted-foreground)]">{`${r.questionCode} · v${r.version}`}</span>
                  <span className="line-clamp-2">{r.preview}</span>
                </OpenInEditor>
              </td>
              <td className="py-2 pr-3">
                <div>{r.examName}</div>
                <div className="text-xs text-[var(--color-muted-foreground)]">{r.series === "PYQ" ? (r.paperLabel ? `PYQ ${r.paperLabel}` : "PYQ") : "Most Missed"}</div>
              </td>
              <td className="py-2 pr-3 text-xs" data-testid="row-published-at">{r.publishedAt ? fmt(r.publishedAt) : "—"}</td>
              <td className="py-2 pr-3 text-xs">
                <div className="font-mono" data-testid="row-media-id">{r.igMediaId ?? "—"}</div>
                {r.igPermalink ? (
                  <a className="mt-1 inline-flex items-center gap-1 underline" href={r.igPermalink} target="_blank" rel="noreferrer" data-testid="row-permalink">
                    <ExternalLink className="h-3 w-3" aria-hidden /> View on Instagram
                  </a>
                ) : null}
                {r.publishError && r.status !== "PUBLISHED" ? <div className="mt-1 max-w-xs text-[var(--color-error)]">{r.publishError}</div> : null}
              </td>
              <td className="py-2 pr-3">
                <InstagramStatusBadge status={r.status} />
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-6 text-center text-[var(--color-muted-foreground)]">
                {empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
