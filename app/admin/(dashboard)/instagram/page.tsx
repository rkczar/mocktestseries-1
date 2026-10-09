import Link from "next/link";
import { CalendarClock, FileText, Flame } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EditorHost } from "@/components/admin/instagram/editor-host";
import { PostTable } from "@/components/admin/instagram/post-table";
import { listDrafts, studioCounts } from "@/lib/instagram/queries";

export const metadata = { title: "Instagram — Mock Test Series.in Admin" };

/** Admin → Instagram → Create Post: where to start, plus the latest drafts. */
export default async function InstagramCreatePostPage() {
  const [counts, drafts] = await Promise.all([studioCounts(), listDrafts()]);
  const stats = [
    { label: "Drafts", value: counts.DRAFT },
    { label: "Ready", value: counts.READY },
    { label: "Posted", value: counts.PUBLISHED },
    { label: "Failed", value: counts.FAILED },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="studio-counts">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4">
              <div className="text-xs text-[var(--color-muted-foreground)]">{s.label}</div>
              <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Link href="/admin/instagram/pyq" className="block">
          <Card className="h-full hover:bg-[var(--color-surface)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-4 w-4" aria-hidden /> PYQ Series
              </CardTitle>
              <CardDescription>Pick Exam → Year → Paper → Question and build a carousel from a previous year question.</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/admin/instagram/most-missed" className="block">
          <Card className="h-full hover:bg-[var(--color-surface)]">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Flame className="h-4 w-4" aria-hidden /> Most Missed MCQ
              </CardTitle>
              <CardDescription>Today, yesterday or the last 7 days — the questions students got wrong most often, with real Question Insights numbers.</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4" aria-hidden /> Continue a draft
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <EditorHost>
            <PostTable rows={drafts.slice(0, 8)} empty="No drafts yet. Start from PYQ Series or Most Missed MCQ." testId="recent-drafts" />
          </EditorHost>
        </CardContent>
      </Card>
    </div>
  );
}
