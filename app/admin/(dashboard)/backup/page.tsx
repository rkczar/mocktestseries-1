import { Download } from "lucide-react";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StudentReportControls } from "./student-report-controls";

export const metadata = { title: "Backup & Disaster Recovery — Mock Test Series.in Admin" };

const DOWNLOAD_BUTTON =
  "inline-flex shrink-0 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)]";

export default async function BackupPage() {
  const session = await getAdminSession();
  const isMasterAdmin = session?.user?.role === "MASTER_ADMIN";
  const canDownloadSystemReport = session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE) ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Backup &amp; Disaster Recovery</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          The real VPS database/uploads backups run on their own nightly cron schedule — see their status inside the
          report below (Section 15). This page is for the human-readable architecture snapshot, not for triggering
          or restoring backups.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live System Report</CardTitle>
          <CardDescription>
            Download a current, human-readable snapshot of the complete website structure, routes, connections,
            statistics and system status. Generated fresh on every click — nothing is stored on the server.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {canDownloadSystemReport ? (
            <>
              <a href="/api/admin/system-report?format=md" download className={DOWNLOAD_BUTTON}>
                <Download className="h-3.5 w-3.5" aria-hidden />
                Download Markdown
              </a>
              <a href="/api/admin/system-report?format=txt" download className={DOWNLOAD_BUTTON}>
                <Download className="h-3.5 w-3.5" aria-hidden />
                Download TXT
              </a>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Downloading this report requires the Settings permission (Master Admin by default). Ask a Master Admin
              to download it, or request that permission.
            </p>
          )}
        </CardContent>
      </Card>

      {isMasterAdmin ? (
        <Card>
          <CardHeader>
            <CardTitle>Sensitive Data Export</CardTitle>
            <CardDescription>
              MASTER_ADMIN only. A per-student operational export — internal ID, status, enrollment and activity
              counts. Never a disaster-recovery backup, and never includes passwords, password hashes, OTP secrets,
              or session tokens.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StudentReportControls />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
