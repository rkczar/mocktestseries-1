import type { Metadata } from "next";

import { AnnouncementForm } from "../AnnouncementForm";
import { createAnnouncementAction } from "../actions";

export const metadata: Metadata = { title: "New Announcement · Admin" };

export default function NewAnnouncementPage() {
  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">New announcement</h1>
      <div className="mt-6">
        <AnnouncementForm action={createAnnouncementAction} submitLabel="Create announcement" />
      </div>
    </div>
  );
}
