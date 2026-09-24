import "server-only";
import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AttemptSourceType,
  AttemptStatus,
  QuestionStatus,
  QuestionSource,
  StudentStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getGitRepoStatus, getDeploymentStatus, type GitRepoStatus, type DeploymentStatus } from "@/lib/git-repo-status";
import { buildDiagramSource } from "@/lib/diagram-source";
import { buildGraph, type DiagramEntry, type DiagramGraph } from "@/lib/diagram-graph";
import { computeIssues, DIAGRAM_ISSUE_LABELS } from "@/lib/diagram-issues";
import { resolveDisplayStatus } from "@/lib/diagram-status";
import { scanGlobalNavLinks, type GlobalNavGroup } from "@/lib/global-nav-links";
import { ADMIN_CONFIG_LINKS } from "@/lib/diagram-admin-links";
import { ADMIN_NAV } from "@/lib/admin-nav";
import packageJson from "../package.json";

/**
 * MockTestSeries.in — Live System Report generator (Admin -> Backup &
 * Disaster Recovery). Every figure here is read fresh from a canonical
 * source already used elsewhere in the app (the Website Diagram's route
 * scanner/graph, Prisma aggregates, the Git Repository Monitor, the real
 * nightly backup cron on this VPS) — this file deliberately creates NO
 * second route registry, no second architecture source of truth, and no
 * permanent on-disk report. It only reads and renders.
 */

const BACKUP_DB_DIR = "/var/backups/mocktestseries/postgres";
const BACKUP_UPLOADS_DIR = "/var/backups/mocktestseries/uploads";
const BACKUP_DB_LOG = "/var/log/mocktestseries/backup-db.log";
const BACKUP_UPLOADS_LOG = "/var/log/mocktestseries/backup-uploads.log";
const MAX_LOG_BYTES = 65_536;

function heading(text: string, level = 2): string {
  return `${"#".repeat(level)} ${text}`;
}

function fmtDateTimeIst(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date) + " IST";
}

function fmtBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Escapes a value for safe use inside a markdown table cell. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ---------------------------------------------------------------------------
// Route / diagram data — reuses the exact Website Diagram pipeline
// (prisma.routeRegistryEntry -> buildDiagramSource -> buildGraph), never a
// second registry.
// ---------------------------------------------------------------------------

async function loadDiagram(): Promise<{ entries: DiagramEntry[]; graph: DiagramGraph; globalNav: GlobalNavGroup[] }> {
  const dbEntries = await prisma.routeRegistryEntry.findMany({ orderBy: [{ module: "asc" }, { route: "asc" }] });
  const diagramEntries: DiagramEntry[] = dbEntries.map((e) => ({
    pageName: e.pageName,
    route: e.route,
    module: e.module,
    userType: e.userType,
    authRequired: e.authRequired,
    parentRoute: e.parentRoute,
    status: e.status,
  }));
  const { entries, connections } = buildDiagramSource(diagramEntries);
  const graph = buildGraph(entries, connections);
  const globalNav = scanGlobalNavLinks();
  return { entries, graph, globalNav };
}

interface TreeNode {
  route: string;
  pageName: string;
  children: TreeNode[];
}

function buildRouteTree(entries: DiagramEntry[], userType: string): TreeNode[] {
  const list = entries.filter((e) => e.userType === userType);
  const byRoute = new Set(list.map((e) => e.route));
  const childrenOf = new Map<string, DiagramEntry[]>();
  const roots: DiagramEntry[] = [];
  for (const e of list) {
    if (e.parentRoute && byRoute.has(e.parentRoute) && e.parentRoute !== e.route) {
      if (!childrenOf.has(e.parentRoute)) childrenOf.set(e.parentRoute, []);
      childrenOf.get(e.parentRoute)!.push(e);
    } else {
      roots.push(e);
    }
  }
  function toNode(e: DiagramEntry): TreeNode {
    const kids = (childrenOf.get(e.route) ?? []).sort((a, b) => a.route.localeCompare(b.route));
    return { route: e.route, pageName: e.pageName, children: kids.map(toNode) };
  }
  return roots.sort((a, b) => a.route.localeCompare(b.route)).map(toNode);
}

function renderTree(nodes: TreeNode[], prefix = ""): string[] {
  const lines: string[] = [];
  nodes.forEach((node, i) => {
    const isLast = i === nodes.length - 1;
    lines.push(`${prefix}${isLast ? "└── " : "├── "}${node.route}`);
    lines.push(...renderTree(node.children, prefix + (isLast ? "    " : "│   ")));
  });
  return lines;
}

function countApiRoutes(): number {
  const apiDir = path.join(process.cwd(), "app", "api");
  let count = 0;
  function walk(dir: string) {
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (/^route\.(ts|tsx|js)$/.test(e.name)) count++;
    }
  }
  walk(apiDir);
  return count;
}

function countPrismaModels(): number {
  try {
    const schemaPath = path.join(process.cwd(), "prisma", "schema.prisma");
    const src = fsSync.readFileSync(schemaPath, "utf8");
    const matches = src.match(/^model\s+\w+\s*\{/gm);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Backup status — reads the REAL nightly cron backups already running on
// this VPS (/etc/cron.d/mocktestseries-backups): a custom-format pg_dump
// (14-day retention) and an rsync uploads mirror. Nothing here is invented —
// if these paths are ever missing, the report says so plainly instead of
// fabricating a "Backup Center".
// ---------------------------------------------------------------------------

interface BackupFileInfo {
  name: string;
  bytes: number;
  mtime: Date;
}

async function listBackupFiles(dir: string, pattern: RegExp): Promise<BackupFileInfo[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && pattern.test(e.name));
    const infos = await Promise.all(
      files.map(async (f) => {
        const stat = await fs.stat(path.join(dir, f.name));
        return { name: f.name, bytes: stat.size, mtime: stat.mtime };
      })
    );
    return infos.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  } catch {
    return [];
  }
}

async function tailLog(logPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(logPath);
    const fd = await fs.open(logPath, "r");
    try {
      const readLen = Math.min(stat.size, MAX_LOG_BYTES);
      const buf = Buffer.alloc(readLen);
      await fd.read(buf, 0, readLen, stat.size - readLen);
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      return lines.length ? lines[lines.length - 1] : null;
    } finally {
      await fd.close();
    }
  } catch {
    return null;
  }
}

interface BackupStatus {
  dbDumps: BackupFileInfo[];
  uploadsFileCount: number | null;
  uploadsTotalBytes: number | null;
  lastDbLogLine: string | null;
  lastUploadsLogLine: string | null;
}

async function countDirBytes(dir: string): Promise<{ files: number; bytes: number } | null> {
  try {
    let files = 0;
    let bytes = 0;
    async function walk(d: string) {
      const entries = await fs.readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          files++;
          bytes += (await fs.stat(p)).size;
        }
      }
    }
    await walk(dir);
    return { files, bytes };
  } catch {
    return null;
  }
}

async function loadBackupStatus(): Promise<BackupStatus> {
  const [dbDumps, uploads, lastDbLogLine, lastUploadsLogLine] = await Promise.all([
    listBackupFiles(BACKUP_DB_DIR, /\.dump$/),
    countDirBytes(BACKUP_UPLOADS_DIR),
    tailLog(BACKUP_DB_LOG),
    tailLog(BACKUP_UPLOADS_LOG),
  ]);
  return {
    dbDumps,
    uploadsFileCount: uploads?.files ?? null,
    uploadsTotalBytes: uploads?.bytes ?? null,
    lastDbLogLine,
    lastUploadsLogLine,
  };
}

// ---------------------------------------------------------------------------
// Database aggregate counts — bounded COUNT/aggregate queries only, never a
// full-table load. Mirrors the query style already used in
// lib/admin-analytics.ts and the Master Dashboard.
// ---------------------------------------------------------------------------

async function loadCounts() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);

  const [
    adminTotal,
    adminActive,
    roleCount,
    permissionCount,
    studentTotal,
    studentActive,
    studentsToday,
    studentsThisMonth,
    examTotal,
    examActive,
    subjectTotal,
    topicTotal,
    subTopicTotal,
    questionTotal,
    questionPublished,
    questionPyq,
    mockTestTotal,
    grandTestTotal,
    liveTestTotal,
    pyqPaperTotal,
    customModuleTotal,
    attemptTotal,
    attemptSubmitted,
    answersAnswered,
    accuracyAgg,
    aiExplanationTotal,
    savedQuestionTotal,
    reportedQuestionTotal,
    communicationTotal,
    announcementTotal,
    migrationRow,
  ] = await Promise.all([
    prisma.adminUser.count(),
    prisma.adminUser.count({ where: { isActive: true } }),
    prisma.role.count(),
    prisma.permission.count(),
    prisma.student.count(),
    prisma.student.count({ where: { status: StudentStatus.ACTIVE } }),
    prisma.student.count({ where: { createdAt: { gte: startOfToday } } }),
    prisma.student.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.exam.count(),
    prisma.exam.count({ where: { isActive: true } }),
    prisma.subject.count(),
    prisma.topic.count(),
    prisma.subTopic.count(),
    prisma.question.count(),
    prisma.question.count({ where: { status: QuestionStatus.PUBLISHED } }),
    prisma.question.count({ where: { source: QuestionSource.PYQ } }),
    prisma.mockTest.count(),
    prisma.grandTest.count(),
    prisma.liveTest.count(),
    prisma.previousYearPaper.count(),
    prisma.customModule.count(),
    prisma.testAttempt.count(),
    prisma.testAttempt.count({ where: { status: AttemptStatus.SUBMITTED } }),
    prisma.answer.count(),
    prisma.testAttempt.aggregate({
      where: { status: AttemptStatus.SUBMITTED, correctCount: { not: null } },
      _sum: { correctCount: true, totalQuestions: true },
    }),
    prisma.aIExplanation.count(),
    prisma.savedQuestion.count(),
    prisma.reportedQuestion.count(),
    prisma.communication.count(),
    prisma.announcement.count(),
    prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
      SELECT migration_name, finished_at FROM _prisma_migrations
      ORDER BY finished_at DESC NULLS LAST LIMIT 1
    `.catch(() => []),
  ]);

  const correctSum = accuracyAgg._sum.correctCount ?? 0;
  const totalQSum = accuracyAgg._sum.totalQuestions ?? 0;

  return {
    adminTotal,
    adminActive,
    roleCount,
    permissionCount,
    studentTotal,
    studentActive,
    studentsToday,
    studentsThisMonth,
    examTotal,
    examActive,
    subjectTotal,
    topicTotal,
    subTopicTotal,
    questionTotal,
    questionPublished,
    questionPyq,
    mockTestTotal,
    grandTestTotal,
    liveTestTotal,
    pyqPaperTotal,
    customModuleTotal,
    attemptTotal,
    attemptSubmitted,
    answersAnswered,
    accuracyPercent: totalQSum > 0 ? (correctSum / totalQSum) * 100 : null,
    aiExplanationTotal,
    savedQuestionTotal,
    reportedQuestionTotal,
    communicationTotal,
    announcementTotal,
    migrationName: migrationRow[0]?.migration_name ?? null,
  };
}

interface ExamHierarchyRow {
  name: string;
  code: string;
  subjects: number;
  topics: number;
  subTopics: number;
  questions: number;
  mockTests: number;
  grandTests: number;
  liveTests: number;
  pyqPapers: number;
  attempts: number;
}

async function loadExamHierarchy(): Promise<ExamHierarchyRow[]> {
  const exams = await prisma.exam.findMany({
    select: {
      id: true,
      name: true,
      code: true,
      _count: {
        select: {
          subjects: true,
          questions: true,
          mockTests: true,
          grandTests: true,
          liveTests: true,
          previousYearPapers: true,
          testAttempts: true,
        },
      },
    },
    orderBy: { order: "asc" },
  });

  // Topics/SubTopics aren't direct Exam relations — bounded id-only scans
  // (taxonomy tables, not attempt/question volume) aggregated in memory.
  const [topics, subTopics] = await Promise.all([
    prisma.topic.findMany({ select: { subject: { select: { examId: true } } } }),
    prisma.subTopic.findMany({ select: { topic: { select: { subject: { select: { examId: true } } } } } }),
  ]);
  const topicsByExam = new Map<string, number>();
  for (const t of topics) topicsByExam.set(t.subject.examId, (topicsByExam.get(t.subject.examId) ?? 0) + 1);
  const subTopicsByExam = new Map<string, number>();
  for (const st of subTopics) {
    const examId = st.topic.subject.examId;
    subTopicsByExam.set(examId, (subTopicsByExam.get(examId) ?? 0) + 1);
  }

  return exams.map((e) => ({
    name: e.name,
    code: e.code,
    subjects: e._count.subjects,
    topics: topicsByExam.get(e.id) ?? 0,
    subTopics: subTopicsByExam.get(e.id) ?? 0,
    questions: e._count.questions,
    mockTests: e._count.mockTests,
    grandTests: e._count.grandTests,
    liveTests: e._count.liveTests,
    pyqPapers: e._count.previousYearPapers,
    attempts: e._count.testAttempts,
  }));
}

interface RoleSummary {
  name: string;
  permissionCount: number;
  adminCount: number;
  activeAdminCount: number;
}

async function loadRoleSummary(): Promise<RoleSummary[]> {
  const roles = await prisma.role.findMany({
    select: {
      name: true,
      _count: { select: { permissions: true } },
      adminUsers: { select: { isActive: true } },
    },
  });
  return roles.map((r) => ({
    name: r.name,
    permissionCount: r._count.permissions,
    adminCount: r.adminUsers.length,
    activeAdminCount: r.adminUsers.filter((a) => a.isActive).length,
  }));
}

// ---------------------------------------------------------------------------
// Secret redaction safety net — defense in depth. Every value plugged into
// this report is a count, a status enum, or data already read from
// git-repo-status.ts / diagram code that never touches secrets, but this
// scan runs over the FINAL rendered text before it is ever returned, so a
// future accidental inclusion fails the whole generation instead of leaking.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /postgres(?:ql)?:\/\/\S+:\S+@\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/,
  /\bDATABASE_URL\s*=/,
  /\bAUTH_SECRET\s*=/,
  /\bpasswordHash\b\s*[:=]/i,
  /\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/]{40,}/,
];

export function scanForSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) hits.push(re.source);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderGitSection(repo: GitRepoStatus, deploy: DeploymentStatus): string[] {
  const lines: string[] = [heading("SECTION 14 — GIT / DEPLOYMENT STATUS")];
  if (!repo.available) {
    lines.push("", "Git repository state is unavailable on this server.", "");
    return lines;
  }
  const tree = repo.workingTree;
  lines.push(
    "",
    `- Repository: ${repo.repoName}`,
    `- Branch: ${repo.detached ? "Detached HEAD" : repo.branch}`,
    `- Current SHA: \`${repo.headSha}\``,
    `- Production SHA: ${deploy.productionReleaseSha ? `\`${deploy.productionReleaseSha}\`` : "unavailable"}`,
    `- Production vs repository: ${deploy.matchesRepoHead == null ? "unknown" : deploy.matchesRepoHead ? "In sync" : "Different commit"}`,
    `- Latest commit: ${repo.latestCommit ? `"${repo.latestCommit.message}" — ${repo.latestCommit.authorName}` : "—"}`,
    `- Working tree: ${tree?.clean ? "Clean" : "Modified"}`,
    `- Modified files: ${tree?.modifiedCount ?? "—"}`,
    `- Untracked files: ${tree?.untrackedCount ?? "—"}`,
    `- Remote status: ${repo.remote.note}`,
    `- Process status: ${deploy.pm2.found ? deploy.pm2.status : (deploy.pm2.error ?? "unavailable")}`,
    ""
  );
  return lines;
}

function renderBackupSection(backup: BackupStatus): string[] {
  const lines: string[] = [heading("SECTION 15 — BACKUP STATUS")];
  if (backup.dbDumps.length === 0) {
    lines.push("", "No recognized VPS database backups found at " + BACKUP_DB_DIR + ".", "");
  } else {
    const newest = backup.dbDumps[backup.dbDumps.length - 1];
    const oldest = backup.dbDumps[0];
    const totalBytes = backup.dbDumps.reduce((s, f) => s + f.bytes, 0);
    lines.push(
      "",
      `- Recognized VPS database backups: ${backup.dbDumps.length} (pg_dump, custom format, 14-day retention)`,
      `- Total database backup storage: ${fmtBytes(totalBytes)}`,
      `- Newest backup: ${newest.name} (${fmtDateTimeIst(newest.mtime)}, ${fmtBytes(newest.bytes)})`,
      `- Oldest backup: ${oldest.name} (${fmtDateTimeIst(oldest.mtime)})`,
      `- Last successful backup generation (log): ${backup.lastDbLogLine ?? "no log entries found"}`,
      ""
    );
  }
  lines.push(
    `- Uploads mirror (rsync, no deletions): ${backup.uploadsFileCount != null ? `${backup.uploadsFileCount} files, ${fmtBytes(backup.uploadsTotalBytes ?? 0)}` : "unavailable"}`,
    `- Uploads backup log: ${backup.lastUploadsLogLine ?? "no log entries found"}`,
    ""
  );
  return lines;
}

function renderSection3(graph: DiagramGraph): string[] {
  const lines: string[] = [heading("SECTION 3 — PAGE CONNECTION MAP")];
  for (const node of [...graph.nodes].sort((a, b) => a.route.localeCompare(b.route))) {
    const status = resolveDisplayStatus({
      status: node.status,
      deprecated: node.deprecated,
      missing: node.missing,
      isolated: node.isolated,
      noIncoming: node.noIncoming,
    });
    const incoming = node.incoming.length ? node.incoming.map((c) => `${c.nodeId} (${c.source}${c.broken ? ", broken" : ""})`).join("; ") : "none";
    const outgoing = node.outgoing.length ? node.outgoing.map((c) => `${c.nodeId} (${c.source}${c.broken ? ", broken" : ""})`).join("; ") : "none";
    const redirects = node.outgoing.filter((c) => c.source === "redirect").map((c) => c.nodeId);
    lines.push(
      "",
      `**${node.route}**`,
      `- Type: ${node.userType}`,
      `- Status: ${status.label}`,
      `- Module: ${node.module}`,
      `- Incoming: ${incoming}`,
      `- Outgoing: ${outgoing}`,
      `- Redirects: ${redirects.length ? redirects.join(", ") : "none"}`,
      `- Authentication: ${node.authRequired ? "Required" : "Public"}`
    );
  }
  lines.push("");
  return lines;
}

function renderSection4(graph: DiagramGraph): string[] {
  const lines: string[] = [heading("SECTION 4 — BACKLINK / INCOMING LINK REPORT"), ""];
  const withIncoming = [...graph.nodes].filter((n) => n.incoming.length > 0).sort((a, b) => a.route.localeCompare(b.route));
  if (!withIncoming.length) {
    lines.push("No routes with recorded incoming links.", "");
    return lines;
  }
  for (const node of withIncoming) {
    lines.push(node.route);
    for (const c of node.incoming) lines.push(`← ${c.label ?? c.source} (${c.nodeId})`);
    lines.push("");
  }
  return lines;
}

function renderSection5(connections: DiagramGraph["edges"]): string[] {
  const lines: string[] = [heading("SECTION 5 — REDIRECT MAP"), ""];
  const redirects = connections.filter((c) => c.source === "redirect");
  if (!redirects.length) {
    lines.push("No redirects currently recorded.", "");
    return lines;
  }
  for (const r of redirects) {
    lines.push(`${r.from}`, `→ ${r.to}`, `Reason: ${r.label ?? "redirect"}`, "");
  }
  return lines;
}

function renderSection6(graph: DiagramGraph): string[] {
  const lines: string[] = [heading("SECTION 6 — BROKEN / DISCONNECTED ROUTES"), ""];
  const issues = computeIssues(graph);
  if (!issues.length) {
    lines.push("No broken, disconnected, or draft routes detected by the route-health scanner.", "");
    return lines;
  }
  for (const issue of issues) {
    lines.push(`- **${DIAGRAM_ISSUE_LABELS[issue.kind]}** — ${issue.nodeId}: ${issue.detail}`);
  }
  lines.push("");
  return lines;
}

export interface SystemReportData {
  generatedAt: Date;
  environment: string;
  appVersion: string;
  migrationName: string | null;
  repo: GitRepoStatus;
  deploy: DeploymentStatus;
  entries: DiagramEntry[];
  graph: DiagramGraph;
  globalNav: GlobalNavGroup[];
  apiRouteCount: number;
  prismaModelCount: number;
  counts: Awaited<ReturnType<typeof loadCounts>>;
  examHierarchy: ExamHierarchyRow[];
  roleSummary: RoleSummary[];
  backup: BackupStatus;
}

export async function collectSystemReportData(): Promise<SystemReportData> {
  const [{ entries, graph, globalNav }, repo, deploy, counts, examHierarchy, roleSummary, backup] = await Promise.all([
    loadDiagram(),
    getGitRepoStatus(),
    getDeploymentStatus(),
    loadCounts(),
    loadExamHierarchy(),
    loadRoleSummary(),
    loadBackupStatus(),
  ]);

  return {
    generatedAt: new Date(),
    environment: process.env.NODE_ENV ?? "unknown",
    appVersion: packageJson.version ?? "unknown",
    migrationName: counts.migrationName,
    repo,
    deploy,
    entries,
    graph,
    globalNav,
    apiRouteCount: countApiRoutes(),
    prismaModelCount: countPrismaModels(),
    counts,
    examHierarchy,
    roleSummary,
    backup,
  };
}

export function renderSystemReportMarkdown(data: SystemReportData): string {
  const { graph, entries, counts } = data;
  const liveCount = graph.nodes.filter((n) => resolveDisplayStatus({ status: n.status, deprecated: n.deprecated, missing: n.missing, isolated: n.isolated, noIncoming: n.noIncoming }).key === "WORKING").length;
  const draftCount = graph.nodes.filter((n) => n.status === "DRAFT" && !n.deprecated).length;
  // Same classifier as the per-route Status lines (resolveDisplayStatus), so the
  // summary can never disagree with the detailed route data.
  const brokenCount = graph.nodes.filter((n) => {
    const key = resolveDisplayStatus({ status: n.status, deprecated: n.deprecated, missing: n.missing, isolated: n.isolated, noIncoming: n.noIncoming }).key;
    return key === "BROKEN" || key === "MISSING";
  }).length;
  const redirectCount = graph.edges.filter((e) => e.source === "redirect").length;
  const publicCount = graph.nodes.filter((n) => n.userType === "PUBLIC").length;
  const studentCount = graph.nodes.filter((n) => n.userType === "STUDENT").length;
  const adminCount = graph.nodes.filter((n) => n.userType === "ADMIN").length;

  const out: string[] = [];
  out.push("# MockTestSeries.in — Live System Report", "");
  out.push(heading("SECTION 1 — SYSTEM SUMMARY"), "");
  out.push(
    `- Generated At: ${fmtDateTimeIst(data.generatedAt)}`,
    `- Environment: ${data.environment}`,
    `- Application Version: ${data.appVersion}`,
    `- Current Git Branch: ${data.repo.available ? (data.repo.detached ? "Detached HEAD" : data.repo.branch) : "unavailable"}`,
    `- Current Git SHA: ${data.repo.available ? `\`${data.repo.headSha}\`` : "unavailable"}`,
    `- Production SHA: ${data.deploy.productionReleaseSha ? `\`${data.deploy.productionReleaseSha}\`` : "unavailable"}`,
    `- Database schema/migration version: ${data.migrationName ?? "unavailable"}`,
    "",
    "**Routes**",
    `- Total Routes: ${graph.nodes.length}`,
    `- Live Routes: ${liveCount}`,
    `- Draft Routes: ${draftCount}`,
    `- Broken Routes: ${brokenCount}`,
    `- Broken Connections: ${graph.brokenEdges.length}`,
    `- Redirect Routes: ${redirectCount}`,
    `- Public Pages: ${publicCount}`,
    `- Student Pages: ${studentCount}`,
    `- Admin Pages: ${adminCount}`,
    `- API Routes: ${data.apiRouteCount}`,
    "",
    "**Admin / RBAC**",
    `- Total Admin Accounts: ${counts.adminTotal}`,
    `- Active Admin Accounts: ${counts.adminActive}`,
    `- Roles: ${counts.roleCount}`,
    `- Permissions: ${counts.permissionCount}`,
    "",
    "**Students**",
    `- Total Students: ${counts.studentTotal}`,
    `- Active Students: ${counts.studentActive}`,
    "",
    "**Exams / Content**",
    `- Total Exams: ${counts.examTotal}`,
    `- Active Exams: ${counts.examActive}`,
    `- Total Subjects: ${counts.subjectTotal}`,
    `- Total Topics: ${counts.topicTotal}`,
    `- Total SubTopics: ${counts.subTopicTotal}`,
    `- Total Questions: ${counts.questionTotal}`,
    `- Published Questions: ${counts.questionPublished}`,
    `- PYQ Questions: ${counts.questionPyq}`,
    "",
    "**Tests**",
    `- Total Mock Tests: ${counts.mockTestTotal}`,
    `- Total Grand Tests: ${counts.grandTestTotal}`,
    `- Total Live Tests: ${counts.liveTestTotal}`,
    `- Total PYQ Papers: ${counts.pyqPaperTotal}`,
    `- Total Custom Modules: ${counts.customModuleTotal}`,
    "",
    "**Activity**",
    `- Total Test Attempts: ${counts.attemptTotal}`,
    `- Submitted Attempts: ${counts.attemptSubmitted}`,
    `- Answers Recorded: ${counts.answersAnswered}`,
    `- Average Accuracy (submitted attempts): ${counts.accuracyPercent != null ? `${counts.accuracyPercent.toFixed(1)}%` : "not yet measurable"}`,
    `- AI Explanations Generated: ${counts.aiExplanationTotal}`,
    `- Saved Questions: ${counts.savedQuestionTotal}`,
    `- Question Reports: ${counts.reportedQuestionTotal}`,
    `- Communications: ${counts.communicationTotal}`,
    `- Announcements: ${counts.announcementTotal}`,
    ""
  );

  out.push(heading("SECTION 2 — COMPLETE WEBSITE ROUTE STRUCTURE"), "", "```");
  out.push("PUBLIC", ...renderTree(buildRouteTree(entries, "PUBLIC")), "");
  out.push("STUDENT", ...renderTree(buildRouteTree(entries, "STUDENT")), "");
  out.push("ADMIN", ...renderTree(buildRouteTree(entries, "ADMIN")));
  out.push("```", "");

  out.push(...renderSection3(graph));
  out.push(...renderSection4(graph));
  out.push(...renderSection5(graph.edges));
  out.push(...renderSection6(graph));

  out.push(heading("SECTION 7 — ADMIN STRUCTURE"), "");
  out.push("**Admin sections (sidebar)**", "");
  for (const item of ADMIN_NAV) out.push(`- ${item.label} (${item.href})`);
  out.push("", "**Roles**", "", "| Role | Permissions | Admins | Active |", "|---|---|---|---|");
  for (const r of data.roleSummary) out.push(`| ${cell(r.name)} | ${r.permissionCount} | ${r.adminCount} | ${r.activeAdminCount} |`);
  out.push("", `Total Admin Accounts: ${counts.adminTotal} · Active: ${counts.adminActive} · Disabled: ${counts.adminTotal - counts.adminActive}`, "");

  out.push(heading("SECTION 8 — STUDENT SYSTEM SUMMARY"), "");
  out.push(
    `- Total Students: ${counts.studentTotal}`,
    `- Active Students: ${counts.studentActive}`,
    `- Registrations Today: ${counts.studentsToday}`,
    `- Registrations This Month: ${counts.studentsThisMonth}`,
    `- Total Test Attempts: ${counts.attemptTotal}`,
    `- Questions Answered: ${counts.answersAnswered}`,
    `- Average Accuracy: ${counts.accuracyPercent != null ? `${counts.accuracyPercent.toFixed(1)}%` : "not yet measurable"}`,
    "",
    "_No student names, emails, phone numbers, or passwords are included in this report. See the separate Student Data Report (MASTER_ADMIN only) for a per-student export._",
    ""
  );

  out.push(heading("SECTION 9 — EXAM / QUESTION STRUCTURE"), "");
  out.push("| Exam | Subjects | Topics | SubTopics | Questions | Mock | Grand | Live | PYQ | Attempts |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const e of data.examHierarchy) {
    out.push(`| ${cell(e.name)} (${cell(e.code)}) | ${e.subjects} | ${e.topics} | ${e.subTopics} | ${e.questions} | ${e.mockTests} | ${e.grandTests} | ${e.liveTests} | ${e.pyqPapers} | ${e.attempts} |`);
  }
  out.push("");

  out.push(heading("SECTION 10 — TEST ENGINE CONNECTION MAP"), "", "```");
  const sourceLines = Object.values(AttemptSourceType).map((s) => s.replace(/_/g, " "));
  const width = Math.max(...sourceLines.map((s) => s.length)) + 2;
  sourceLines.forEach((s, i) => {
    const pad = "─".repeat(width - s.length - 1);
    out.push(`${s} ${pad}${i === 0 ? "┐" : i === sourceLines.length - 1 ? "┘" : "┤"}`);
  });
  out.push(
    "".padStart(Math.floor(width / 2) + 2, " ") + "↓",
    "TestAttempt",
    "  ↓",
    "TestAttemptQuestion / Answer",
    "  ↓",
    "Result",
    "  ↓",
    "Review",
    "  ↓",
    "AI Explanation / Saved Question / Question Report"
  );
  out.push("```", "");

  out.push(heading("SECTION 11 — ADMIN → FRONTEND CONNECTION MAP"), "");
  for (const link of ADMIN_CONFIG_LINKS) out.push(`- ${link.from}`, `  → ${link.to}`, `  (${link.label})`, "");

  out.push(heading("SECTION 12 — HEADER / FOOTER CONNECTIONS"), "");
  for (const group of data.globalNav) {
    out.push(`**${group.label}**`, "");
    for (const link of group.links) out.push(`- → ${link}`);
    out.push("");
  }

  out.push(heading("SECTION 13 — DATABASE STRUCTURE SUMMARY"), "");
  out.push(
    `- Total Prisma Models: ${data.prismaModelCount}`,
    "",
    "**Verified core relationships** (from prisma/schema.prisma):",
    "- RBAC: AdminUser → Role → RolePermission → Permission",
    "- Question taxonomy: Exam → Subject → Topic → SubTopic → Question",
    "- Test engine: Exam → {MockTest, GrandTest, LiveTest, CustomModule, PreviousYearPaper} → TestAttempt → {TestAttemptQuestion, Answer}",
    "- Ownership: Student → {TestAttempt, SavedQuestion, ReportedQuestion, Communication, StudentExamEnrollment}",
    "- Communications: Communication → Student (optional) / AdminUser (assignee)",
    ""
  );

  out.push(...renderGitSection(data.repo, data.deploy));
  out.push(...renderBackupSection(data.backup));

  out.push(heading("SECTION 16 — SYSTEM CONNECTION OVERVIEW"), "", "```");
  out.push(
    "PUBLIC / STUDENT / ADMIN WEBSITE",
    `      │  (${graph.nodes.length} routes: ${publicCount} public, ${studentCount} student, ${adminCount} admin)`,
    "      ↓",
    "DATABASE / APPLICATION SERVICES",
    `      │  (${data.prismaModelCount} Prisma models)`,
    "  ┌───┼────────┐",
    "  ↓   ↓        ↓",
    `Questions(${counts.questionTotal})  Tests(${counts.mockTestTotal + counts.grandTestTotal + counts.liveTestTotal})  Students(${counts.studentTotal})`,
    "  └───┼────────┘",
    "      ↓",
    `TestAttempt (${counts.attemptTotal} total, ${counts.attemptSubmitted} submitted)`,
    "      ↓",
    "Results / Review / Analytics",
    "      ↓",
    `ADMIN PANEL (${counts.adminTotal} accounts, ${counts.roleCount} roles)`
  );
  out.push("```", "");

  return out.join("\n");
}

/** Rough markdown -> plain text: strips heading/bold/code markers, keeps ascii trees/tables as-is (already plain-text-readable). */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1"))
    .join("\n");
}

export async function generateSystemReport(): Promise<{ markdown: string; text: string; generatedAt: Date }> {
  const data = await collectSystemReportData();
  const markdown = renderSystemReportMarkdown(data);
  const hits = scanForSecrets(markdown);
  if (hits.length > 0) {
    throw new Error("System report generation aborted: content matched a secret-shaped pattern and was not returned.");
  }
  return { markdown, text: markdownToPlainText(markdown), generatedAt: data.generatedAt };
}

export function systemReportFilename(generatedAt: Date, ext: "md" | "txt"): string {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(generatedAt);
  const get = (type: string) => dateParts.find((p) => p.type === type)?.value ?? "00";
  return `mocktestseries-system-report-${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}.${ext}`;
}
