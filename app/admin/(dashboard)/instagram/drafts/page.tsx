import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EditorHost } from "@/components/admin/instagram/editor-host";
import { PostTable } from "@/components/admin/instagram/post-table";
import { listDrafts } from "@/lib/instagram/queries";

export const metadata = { title: "Drafts — Instagram — Mock Test Series.in Admin" };

/** Admin → Instagram → Drafts: every current Draft / Failed post, newest first. */
export default async function InstagramDraftsPage() {
  const rows = await listDrafts();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Drafts</CardTitle>
        <CardDescription>Draft and Failed posts. Click one to open its carousel, or use Publish to Instagram to go straight to the final confirmation.</CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        <EditorHost>
          <PostTable rows={rows} empty="No drafts yet." testId="drafts-table" showPublish />
        </EditorHost>
      </CardContent>
    </Card>
  );
}
