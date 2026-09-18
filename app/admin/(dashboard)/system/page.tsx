import type { ReactNode } from "react";
import Link from "next/link";
import { GitBranch, ArrowRight } from "lucide-react";
import { getStorageSnapshot, formatBytes } from "@/lib/storage-stats";
import { getGitRepoStatus, getDeploymentStatus, type GitRepoStatus, type DeploymentStatus } from "@/lib/git-repo-status";
import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StorageScanButton } from "./storage-panel";
import { RefreshRepoStatusButton, FetchRemoteStatusButton } from "./git-actions";

export const metadata = { title: "System — Mock Test Series.in Admin" };

function formatWhen(ts: number) {
  return new Date(ts).toLocaleString("en-IN");
}

function formatCommitDate(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-IN");
}

export default async function SystemPage() {
  const [snapshot, repoStatus, deployStatus] = await Promise.all([
    getStorageSnapshot(),
    getGitRepoStatus(),
    getDeploymentStatus(),
  ]);
  const usedPercent =
    snapshot.filesystem.totalBytes && snapshot.filesystem.usedBytes
      ? Math.round((snapshot.filesystem.usedBytes / snapshot.filesystem.totalBytes) * 100)
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">System</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          VPS disk usage, database size, a directory-level storage breakdown, and the git repository this app is
          built from.
        </p>
      </div>

      <ControlCenterTabs
        defaultValue="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <OverviewTab snapshot={snapshot} usedPercent={usedPercent} /> },
          { value: "storage", label: "Storage", content: <StorageTab snapshot={snapshot} /> },
          {
            value: "repository",
            label: "Git Repository",
            content: <RepositoryTab repo={repoStatus} deploy={deployStatus} />,
          },
        ]}
      />
    </div>
  );
}

function OverviewTab({
  snapshot,
  usedPercent,
}: {
  snapshot: Awaited<ReturnType<typeof getStorageSnapshot>>;
  usedPercent: number | null;
}) {
  return (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Disk used
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-[var(--color-foreground)]">
                  {formatBytes(snapshot.filesystem.usedBytes)}
                  {usedPercent != null ? (
                    <span className="ml-1 text-sm font-normal text-[var(--color-muted-foreground)]">
                      ({usedPercent}%)
                    </span>
                  ) : null}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Disk free
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-[var(--color-foreground)]">
                  {formatBytes(snapshot.filesystem.availBytes)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  Database size
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-[var(--color-foreground)]">
                  {formatBytes(snapshot.database.bytes)}
                </p>
              </CardContent>
            </Card>
          </div>
  );
}

function StorageTab({ snapshot }: { snapshot: Awaited<ReturnType<typeof getStorageSnapshot>> }) {
  return (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <div>
                <CardTitle>Storage breakdown</CardTitle>
                <CardDescription>Last scanned {formatWhen(snapshot.scannedAt)}</CardDescription>
              </div>
              <StorageScanButton />
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[420px] text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                      <th className="pb-2 font-medium">Directory</th>
                      <th className="pb-2 font-medium">Size</th>
                      <th className="pb-2 font-medium">% of scanned total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {snapshot.categories.map((cat) => {
                      const pct =
                        cat.bytes != null && snapshot.totalUsedBytes
                          ? Math.round((cat.bytes / snapshot.totalUsedBytes) * 100)
                          : null;
                      return (
                        <tr key={cat.label}>
                          <td className="py-2 text-[var(--color-foreground)]">{cat.label}</td>
                          <td className="py-2 text-[var(--color-foreground)]">
                            {cat.error ? "Unavailable" : formatBytes(cat.bytes)}
                          </td>
                          <td className="py-2 text-[var(--color-muted-foreground)]">{pct != null ? `${pct}%` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
  );
}

function RepositoryTab({ repo, deploy }: { repo: GitRepoStatus; deploy: DeploymentStatus }) {
  if (!repo.available) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Git Repository</CardTitle>
          <CardDescription>{repo.error ?? "Repository status is unavailable."}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const tree = repo.workingTree;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <p className="text-xs text-[var(--color-muted-foreground)]">Last checked {formatWhen(repo.scannedAt)}</p>
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
          <RefreshRepoStatusButton />
          <FetchRemoteStatusButton remoteConfigured={repo.remote.configured} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Repository</CardTitle>
          <CardDescription>Read-only snapshot of the local git working copy on this server.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <Field label="Repository name" value={repo.repoName} />
            <Field label="Current branch" value={repo.detached ? "Detached HEAD" : (repo.branch ?? "—")} />
            <Field label="Current commit SHA" value={repo.headSha ?? "—"} mono />
            <Field
              label="Working tree"
              value={
                tree ? (
                  <Badge variant={tree.clean ? "success" : "warning"}>{tree.clean ? "Clean" : "Modified"}</Badge>
                ) : (
                  "—"
                )
              }
            />
            <Field
              label="Modified / untracked files"
              value={tree ? `${tree.modifiedCount} modified · ${tree.untrackedCount} untracked · ${tree.stagedCount} staged` : "—"}
            />
            <Field
              label="Local HEAD vs remote"
              value={
                repo.remote.ahead != null && repo.remote.behind != null
                  ? `${repo.remote.ahead} ahead · ${repo.remote.behind} behind (${repo.remote.upstreamRef})`
                  : repo.remote.note
              }
            />
          </dl>
          {repo.latestCommit ? (
            <div className="mt-4 rounded-[var(--radius-button)] border border-[var(--color-border)] p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
                Latest commit
              </p>
              <p className="mt-1 text-sm font-medium text-[var(--color-foreground)]">{repo.latestCommit.message}</p>
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                {repo.latestCommit.authorName} · {formatCommitDate(repo.latestCommit.date)}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Git history</CardTitle>
          <CardDescription>Most recent commits on {repo.detached ? "HEAD" : (repo.branch ?? "this branch")}.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-muted-foreground)]">
                  <th className="pb-2 font-medium">SHA</th>
                  <th className="pb-2 font-medium">Message</th>
                  <th className="pb-2 font-medium">Author</th>
                  <th className="pb-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {repo.recentCommits.map((commit) => (
                  <tr key={commit.sha}>
                    <td className="py-2 font-mono text-xs text-[var(--color-foreground)]">{commit.shortSha}</td>
                    <td className="py-2 text-[var(--color-foreground)]">{commit.message}</td>
                    <td className="py-2 text-[var(--color-muted-foreground)]">{commit.authorName}</td>
                    <td className="py-2 text-[var(--color-muted-foreground)]">{formatCommitDate(commit.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GitHub &amp; deployment</CardTitle>
          <CardDescription>Only shown where real integration data is available — nothing here is fabricated.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">GitHub</p>
            {repo.remote.githubUrl ? (
              <a
                href={repo.remote.githubUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-primary)] hover:underline"
              >
                {repo.remote.githubUrl}
              </a>
            ) : (
              <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
                Not configured — this repository has no GitHub remote on this server.
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{deploy.github.reason}</p>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
              Production deployment (PM2 / release directory)
            </p>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field
                label="Production release commit"
                value={deploy.productionReleaseSha ?? deploy.productionReleaseError ?? "—"}
                mono={!!deploy.productionReleaseSha}
              />
              <Field
                label="Production vs repository HEAD"
                value={
                  deploy.matchesRepoHead == null ? (
                    "—"
                  ) : (
                    <Badge variant={deploy.matchesRepoHead ? "success" : "warning"}>
                      {deploy.matchesRepoHead ? "In sync" : "Different commit"}
                    </Badge>
                  )
                }
              />
              <Field
                label="Process status"
                value={
                  deploy.pm2.found && deploy.pm2.status ? (
                    <Badge variant={deploy.pm2.status === "online" ? "success" : "error"}>{deploy.pm2.status}</Badge>
                  ) : (
                    deploy.pm2.error ?? "—"
                  )
                }
              />
              <Field
                label="Restarts"
                value={deploy.pm2.restarts != null ? String(deploy.pm2.restarts) : "—"}
              />
            </dl>
          </div>
        </CardContent>
      </Card>

      <Link
        href="/admin/website/diagram"
        className="inline-flex w-fit items-center gap-2 rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-surface)]"
      >
        <GitBranch className="h-3.5 w-3.5" aria-hidden />
        This repository&rsquo;s code powers every page mapped in the Website Diagram
        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{label}</dt>
      <dd className={`mt-1 text-sm text-[var(--color-foreground)] ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
