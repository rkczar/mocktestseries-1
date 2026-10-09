import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EditorHost } from "@/components/admin/instagram/editor-host";
import { PostTable } from "@/components/admin/instagram/post-table";
import { listHistory } from "@/lib/instagram/queries";

export const metadata = { title: "Published History — Instagram — Mock Test Series.in Admin" };

/** Admin → Instagram → Published History: posted carousels, then every post version ever created. */
export default async function InstagramHistoryPage() {
  const rows = await listHistory();
  const published = rows.filter((r) => r.status === "PUBLISHED");
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Published</CardTitle>
          <CardDescription>Questions already posted show “Instagram ✓ Posted” everywhere in the studio, so they are not posted twice by accident.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <EditorHost>
            <PostTable rows={published} empty="Nothing has been published — publishing is not enabled yet." testId="published-table" showPublished />
          </EditorHost>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>All posts and versions</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <EditorHost>
            <PostTable rows={rows} empty="No posts yet." testId="all-posts-table" />
          </EditorHost>
        </CardContent>
      </Card>
    </div>
  );
}
