import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";

import { AnnouncementForm } from "../../AnnouncementForm";
import { updateAnnouncementAction } from "../../actions";

export const metadata: Metadata = { title: "Edit Announcement · Admin" };

export default async function EditAnnouncementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const announcement = await prisma.announcement.findUnique({ where: { id } });
  if (!announcement) notFound();

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Edit announcement</h1>
      <div className="mt-6">
        <AnnouncementForm
          announcement={announcement}
          action={updateAnnouncementAction}
          submitLabel="Save changes"
        />
      </div>
    </div>
  );
}
