import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EditorHost } from "@/components/admin/instagram/editor-host";
import { PostTable } from "@/components/admin/instagram/post-table";
import { PublishedTable } from "@/components/admin/instagram/published-table";
import { listHistory, listPublishActivity } from "@/lib/instagram/queries";
import { COMPARE_DIMENSIONS, compareBy, listPublishedPerformance } from "@/lib/instagram/metrics";
import { Performance } from "@/components/admin/instagram/performance";

export const metadata = { title: "Published History — Instagram — Mock Test Series.in Admin" };

/** Admin → Instagram → Published History: posted carousels, posts being published / failed, then every post version ever created. */
export default async function InstagramHistoryPage() {
  const [rows, activity, perf] = await Promise.all([listHistory(), listPublishActivity(), listPublishedPerformance()]);
  const compare = Object.fromEntries(COMPARE_DIMENSIONS.map((d) => [d.key, compareBy(perf, d.key)]));
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Published on Instagram</CardTitle>
          <CardDescription>Questions already posted show “Instagram ✓ Posted” everywhere in the studio, so they are not posted twice by accident. Published posts are never deleted from Instagram by the studio.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <EditorHost>
            <PublishedTable rows={activity.published} empty="Nothing has been published yet." testId="published-table" />
          </EditorHost>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Performance &amp; analytics</CardTitle>
          <CardDescription>Views, reach, likes, comments, saves and shares from the Instagram API for posts published from the studio, compared by exam, subject, topic, design mode, template, caption style and carousel length. These numbers also feed the Content Opportunity Score.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5">
          <Performance rows={perf} compare={compare} dims={COMPARE_DIMENSIONS.map((d) => ({ key: d.key, label: d.label }))} />
        </CardContent>
      </Card>
      {activity.active.length ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle>Publishing now / failed</CardTitle>
            <CardDescription>Open a post to see its progress, check its status with Instagram, or retry a failed publish.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <EditorHost>
              <PublishedTable rows={activity.active} empty="" testId="publish-activity-table" />
            </EditorHost>
          </CardContent>
        </Card>
      ) : null}
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
