import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Container } from "@/components/common/Container";
import { adminAuth } from "@/lib/auth/admin";

import { adminLogoutAction } from "./actions";

export const metadata: Metadata = { title: "Admin Dashboard", robots: { index: false, follow: false } };

const CONTENT_AREAS = [
  "Homepage",
  "Exams",
  "Test Series",
  "Upcoming Exams",
  "Announcements",
  "Pricing",
  "Question Bank",
  "Students",
  "Admins & Roles",
  "Appearance",
];

export default async function AdminDashboardPage() {
  const session = await adminAuth();
  if (!session) redirect("/admin/login");

  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="border-b border-border bg-surface">
        <Container className="flex h-[72px] items-center justify-between">
          <div>
            <p className="font-display text-lg font-bold text-primary">MockTestSeries.in Admin</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-text-muted">
              {session.user.name} · <span className="font-mono text-xs uppercase">{session.user.role}</span>
            </span>
            <form action={adminLogoutAction}>
              <button
                type="submit"
                className="rounded-[9px] border border-border-strong px-4 py-2.5 text-[14.5px] font-bold text-primary hover:bg-accent"
              >
                Log out
              </button>
            </form>
          </div>
        </Container>
      </header>

      <Container className="py-[clamp(28px,4vw,48px)]">
        <h1 className="font-display text-[clamp(26px,3vw,34px)] font-bold text-text-heading">
          Content areas
        </h1>
        <p className="mt-2 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
          Admin CRUD for each content area is being built next. This dashboard confirms the
          separate admin session and role check are working end to end.
        </p>
        <ul className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          {CONTENT_AREAS.map((area) => (
            <li
              key={area}
              className="rounded-[12px] border border-dashed border-border-strong bg-surface p-4.5 text-sm font-bold text-text-muted"
            >
              {area}
            </li>
          ))}
        </ul>
      </Container>
    </div>
  );
}
