import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EditorHost } from "@/components/admin/instagram/editor-host";
import { PostTable } from "@/components/admin/instagram/post-table";
import { TopicCreate } from "@/components/admin/instagram/topic-create";
import { listTopicPosts } from "@/lib/instagram/queries";
import { listScopedExams } from "@/lib/instagram/scope";

export const metadata = { title: "Topic Posts — Instagram — Mock Test Series.in Admin" };

/** Admin → Instagram → Topic Posts: carousels about a topic (no source question). Same editor, checks and publisher as question posts. */
export default async function InstagramTopicsPage() {
  const [rows, scope] = await Promise.all([listTopicPosts(), listScopedExams()]);
  const exams = scope.exams.filter((e) => e.eligible).map((e) => ({ id: e.id, name: e.name }));
  return (
    <EditorHost>
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>New topic post</CardTitle>
            <CardDescription>
              A carousel that teaches one topic: a cover, teaching slides and the Follow slide. Paste your source notes so the content (yours or the AI&apos;s) is written from them. If the topic already
              has a post, that post opens instead.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <TopicCreate exams={exams} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Topic posts</CardTitle>
            <CardDescription>Current topic posts, newest first. Click one to open its carousel.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <PostTable rows={rows} empty="No topic posts yet." testId="topics-table" showPublish />
          </CardContent>
        </Card>
      </div>
    </EditorHost>
  );
}
