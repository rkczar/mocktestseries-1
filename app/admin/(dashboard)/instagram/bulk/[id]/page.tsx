import { notFound } from "next/navigation";
import Link from "next/link";
import { getBatchView, QUEUE_SPACING_MS } from "@/lib/instagram/batch";
import { getPublishingSwitch, isPublishingConfigured } from "@/lib/instagram/publish";
import { StudioError } from "@/lib/instagram/posts";
import { getAdminSession } from "@/lib/rbac";
import { BulkBatch } from "@/components/admin/instagram/bulk-batch";
import { EditorHost } from "@/components/admin/instagram/editor-host";

export const metadata = { title: "Bulk Studio batch — Instagram — Mock Test Series.in Admin" };

export default async function BulkBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9]{10,40}$/i.test(id)) notFound();
  let view;
  try {
    view = await getBatchView(id);
  } catch (e) {
    if (e instanceof StudioError) notFound();
    throw e;
  }
  const [sw, session] = await Promise.all([getPublishingSwitch(), getAdminSession()]);
  return (
    <div className="flex flex-col gap-3">
      <Link href="/admin/instagram/bulk" className="text-xs text-[var(--color-muted-foreground)] hover:underline">
        ← All batches
      </Link>
      <EditorHost>
        <BulkBatch
          initial={view}
          publishingEnabled={sw.enabled}
          connected={isPublishingConfigured()}
          isMaster={session?.user?.role === "MASTER_ADMIN"}
          spacingSeconds={Math.round(QUEUE_SPACING_MS / 1000)}
        />
      </EditorHost>
    </div>
  );
}
