import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readlink } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * The git working copy used for editing. Deploys are release-based: the
 * running Next.js process's cwd is a release directory under
 * mocktestseries-releases/, which is a plain file copy with no .git — so git
 * commands must always target this fixed editing checkout, never
 * process.cwd(). See the mocktestseries-deploy-topology memory.
 */
export const REPO_DIR = "/var/www/mocktestseries";
const PRODUCTION_CURRENT_LINK = "/var/www/mocktestseries-current";
const PM2_PROCESS_NAME = "mocktestseries";
const GIT_TIMEOUT_MS = 10_000;
const FIELD_SEP = "\x1f";

export interface GitCommit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}

export interface GitWorkingTree {
  clean: boolean;
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
}

export interface GitRemoteStatus {
  configured: boolean;
  url: string | null;
  githubUrl: string | null;
  upstreamRef: string | null;
  ahead: number | null;
  behind: number | null;
  note: string;
}

export interface GitRepoStatus {
  scannedAt: number;
  available: boolean;
  error?: string;
  repoName: string;
  branch: string | null;
  detached: boolean;
  headSha: string | null;
  headShortSha: string | null;
  latestCommit: GitCommit | null;
  workingTree: GitWorkingTree | null;
  recentCommits: GitCommit[];
  remote: GitRemoteStatus;
}

export interface DeploymentStatus {
  scannedAt: number;
  productionLink: string;
  productionReleaseSha: string | null;
  productionReleaseError: string | null;
  matchesRepoHead: boolean | null;
  pm2: {
    found: boolean;
    status: string | null;
    uptimeMs: number | null;
    restarts: number | null;
    error?: string;
  };
  github: {
    configured: false;
    reason: string;
  };
}

/** Fixed argv only, never a shell string — args here are always hardcoded, never client-supplied. */
async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: REPO_DIR, timeout: GIT_TIMEOUT_MS });
  // trimEnd only — `git status --porcelain`'s leading column spaces are significant
  // and a full trim() would corrupt the first line's status codes.
  return stdout.replace(/\s+$/, "");
}

async function tryGit(args: string[]): Promise<string | null> {
  try {
    return await git(args);
  } catch {
    return null;
  }
}

function parseCommitLine(line: string): GitCommit | null {
  const [sha, message, authorName, authorEmail, date] = line.split(FIELD_SEP);
  if (!sha) return null;
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message: message ?? "",
    authorName: authorName ?? "",
    authorEmail: authorEmail ?? "",
    date: date ?? "",
  };
}

async function getRepoName(): Promise<string> {
  try {
    const pkg = await import("../package.json");
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name;
  } catch {
    // fall through
  }
  return path.basename(REPO_DIR);
}

function toGithubUrl(remoteUrl: string): string | null {
  // https://github.com/owner/repo(.git)
  let match = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;
  // git@github.com:owner/repo(.git)
  match = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;
  // ssh://git@github.com/owner/repo(.git)
  match = remoteUrl.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (match) return `https://github.com/${match[1]}/${match[2]}`;
  return null;
}

async function getRemoteStatus(headSha: string | null): Promise<GitRemoteStatus> {
  const url = await tryGit(["remote", "get-url", "origin"]);
  if (!url) {
    return {
      configured: false,
      url: null,
      githubUrl: null,
      upstreamRef: null,
      ahead: null,
      behind: null,
      note: "No git remote is configured for this repository on the server.",
    };
  }

  const githubUrl = toGithubUrl(url);
  const upstreamRef = await tryGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);

  if (!upstreamRef) {
    return {
      configured: true,
      url,
      githubUrl,
      upstreamRef: null,
      ahead: null,
      behind: null,
      note: "Remote is configured but the current branch has no upstream tracking branch.",
    };
  }

  const counts = await tryGit(["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`]);
  if (!counts) {
    return {
      configured: true,
      url,
      githubUrl,
      upstreamRef,
      ahead: null,
      behind: null,
      note: "Could not compare against the upstream ref (it may not be fetched yet).",
    };
  }

  const [aheadStr, behindStr] = counts.split(/\s+/);
  const ahead = Number.parseInt(aheadStr ?? "", 10);
  const behind = Number.parseInt(behindStr ?? "", 10);
  void headSha;

  return {
    configured: true,
    url,
    githubUrl,
    upstreamRef,
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    note:
      Number.isFinite(ahead) && Number.isFinite(behind)
        ? "Compared against the last-fetched remote-tracking ref (may be stale until Fetch Remote Status is run)."
        : "Could not compare against the upstream ref.",
  };
}

function parseWorkingTree(porcelain: string): GitWorkingTree {
  if (!porcelain) return { clean: true, stagedCount: 0, modifiedCount: 0, untrackedCount: 0 };

  const lines = porcelain.split("\n").filter(Boolean);
  let staged = 0;
  let modified = 0;
  let untracked = 0;

  for (const line of lines) {
    const index = line[0];
    const worktree = line[1];
    if (line.startsWith("??")) {
      untracked++;
      continue;
    }
    if (index && index !== " ") staged++;
    if (worktree && worktree !== " ") modified++;
  }

  return { clean: lines.length === 0, stagedCount: staged, modifiedCount: modified, untrackedCount: untracked };
}

const CACHE_TTL_MS = 60 * 1000;
let repoCache: GitRepoStatus | null = null;
let deployCache: DeploymentStatus | null = null;

/**
 * Read-only snapshot of local git state. Never mutates the working tree,
 * index, or refs (the only remote-touching call is the separate, explicit
 * `fetchRemoteStatus`). Cached briefly; pass forceRefresh to re-run.
 */
export async function getGitRepoStatus({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<GitRepoStatus> {
  if (!forceRefresh && repoCache && Date.now() - repoCache.scannedAt < CACHE_TTL_MS) {
    return repoCache;
  }

  const repoName = await getRepoName();

  const headSha = await tryGit(["rev-parse", "HEAD"]);
  if (!headSha) {
    const snapshot: GitRepoStatus = {
      scannedAt: Date.now(),
      available: false,
      error: "Not a git repository, or git is unavailable on this server.",
      repoName,
      branch: null,
      detached: false,
      headSha: null,
      headShortSha: null,
      latestCommit: null,
      workingTree: null,
      recentCommits: [],
      remote: {
        configured: false,
        url: null,
        githubUrl: null,
        upstreamRef: null,
        ahead: null,
        behind: null,
        note: "Unavailable — repository state could not be read.",
      },
    };
    repoCache = snapshot;
    return snapshot;
  }

  const [branchRaw, porcelain, logOutput, remote] = await Promise.all([
    tryGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    tryGit(["status", "--porcelain=v1", "--untracked-files=all"]),
    tryGit(["log", "-n", "15", `--format=%H${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI`]),
    getRemoteStatus(headSha),
  ]);

  const detached = branchRaw === "HEAD";
  const recentCommits = (logOutput ?? "")
    .split("\n")
    .filter(Boolean)
    .map(parseCommitLine)
    .filter((c): c is GitCommit => c != null);

  const snapshot: GitRepoStatus = {
    scannedAt: Date.now(),
    available: true,
    repoName,
    branch: detached ? null : branchRaw,
    detached,
    headSha,
    headShortSha: headSha.slice(0, 7),
    latestCommit: recentCommits[0] ?? null,
    workingTree: parseWorkingTree(porcelain ?? ""),
    recentCommits,
    remote,
  };

  repoCache = snapshot;
  return snapshot;
}

interface Pm2ProcessDescription {
  name?: string;
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
  };
}

async function getPm2Status(): Promise<DeploymentStatus["pm2"]> {
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: GIT_TIMEOUT_MS });
    const list = JSON.parse(stdout) as Pm2ProcessDescription[];
    const proc = list.find((p) => p.name === PM2_PROCESS_NAME);
    if (!proc) return { found: false, status: null, uptimeMs: null, restarts: null, error: "Process not found in pm2" };
    return {
      found: true,
      status: proc.pm2_env?.status ?? null,
      uptimeMs: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
      restarts: proc.pm2_env?.restart_time ?? null,
    };
  } catch {
    return { found: false, status: null, uptimeMs: null, restarts: null, error: "pm2 is not available on this server" };
  }
}

/**
 * Reads the production release symlink and PM2 process status. Both reads
 * are non-destructive (a symlink read and a process-manager status query) —
 * nothing here can push, deploy, restart, or modify anything.
 */
export async function getDeploymentStatus({
  forceRefresh = false,
}: { forceRefresh?: boolean } = {}): Promise<DeploymentStatus> {
  if (!forceRefresh && deployCache && Date.now() - deployCache.scannedAt < CACHE_TTL_MS) {
    return deployCache;
  }

  let productionReleaseSha: string | null = null;
  let productionReleaseError: string | null = null;
  try {
    const target = await readlink(PRODUCTION_CURRENT_LINK);
    productionReleaseSha = path.basename(target);
  } catch {
    productionReleaseError = "Could not read the production release symlink.";
  }

  const [pm2, headSha] = await Promise.all([getPm2Status(), tryGit(["rev-parse", "HEAD"])]);

  const snapshot: DeploymentStatus = {
    scannedAt: Date.now(),
    productionLink: PRODUCTION_CURRENT_LINK,
    productionReleaseSha,
    productionReleaseError,
    matchesRepoHead: productionReleaseSha && headSha ? productionReleaseSha === headSha : null,
    pm2,
    github: {
      configured: false,
      reason: "No GitHub Actions / deployment webhook integration is configured for this repository.",
    },
  };

  deployCache = snapshot;
  return snapshot;
}

export interface FetchRemoteResult {
  ok: boolean;
  message: string;
}

/**
 * The one operation here that touches the network: `git fetch` updates only
 * remote-tracking refs (refs/remotes/origin/*), never the working tree, the
 * index, or the current branch — safe to expose as a read-only "check the
 * remote" action. No-ops with a clear message when no remote is configured.
 */
export async function fetchRemoteStatus(): Promise<FetchRemoteResult> {
  const url = await tryGit(["remote", "get-url", "origin"]);
  if (!url) {
    return { ok: false, message: "No git remote is configured for this repository — nothing to fetch." };
  }
  try {
    await execFileAsync("git", ["fetch", "--quiet", "origin"], { cwd: REPO_DIR, timeout: GIT_TIMEOUT_MS });
    return { ok: true, message: "Fetched the latest refs from origin." };
  } catch {
    return { ok: false, message: "Could not reach the remote (network, auth, or timeout)." };
  }
}
