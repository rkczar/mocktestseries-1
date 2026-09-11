import "server-only";

import fs from "fs";
import path from "path";

import { prisma } from "@/lib/db";

import { scanLinks, type FileInfo, type LinkRef } from "./scanLinks";
import { scanRoutes, type DetectedRoute } from "./scanRoutes";
import type { DiagramEdge, DiagramGraph, DiagramNode, DiagramNodeStatus, DiagramSection, DiagramSummary } from "./types";

const APP_ROOT = path.join(process.cwd(), "app");

/** Files reachable from 4+ distinct routes are treated as shared navigation chrome (header,
 * footer, sidebar, mobile nav) rather than per-page content — otherwise every public page would
 * show a duplicate outgoing edge to every other page for the site-wide header links alone. This
 * threshold is architecture-derived (fan-in), not a maintained list of component names. */
const SHARED_FAN_IN_THRESHOLD = 4;

function findAncestorLayouts(routeFileAbs: string): string[] {
  const layouts: string[] = [];
  let dir = path.dirname(routeFileAbs);
  for (;;) {
    const candidate = path.join(dir, "layout.tsx");
    if (fs.existsSync(candidate)) layouts.push(path.relative(process.cwd(), candidate));
    if (path.resolve(dir) === path.resolve(APP_ROOT)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return layouts;
}

function closureOf(seeds: string[], index: Map<string, FileInfo>): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const info = index.get(file);
    if (!info) continue;
    for (const dep of info.imports) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

function humanizeRoute(route: string): string {
  if (route === "/") return "Home";
  const segments = route.split("/").filter(Boolean);
  return segments
    .map((seg) => {
      const dynamic = seg.match(/^\[\.\.\.(.+)\]$/) ?? seg.match(/^\[(.+)\]$/);
      if (dynamic) return `{${dynamic[1].charAt(0).toUpperCase()}${dynamic[1].slice(1)}}`;
      return seg
        .split(/[-_]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    })
    .join(" / ");
}

function normalizePattern(raw: string): string {
  const withoutQuery = raw.split("?")[0].split("#")[0];
  if (withoutQuery.length > 1 && withoutQuery.endsWith("/")) return withoutQuery.slice(0, -1);
  return withoutQuery || "/";
}

/** Structural match between an extracted reference pattern and a real route's file-based path,
 * treating "%DYNAMIC%" (an unresolved template interpolation) and Next's [param]/[...param]
 * segments as wildcards. A static route segment never matches a %DYNAMIC% pattern segment, and
 * vice versa is only allowed for genuinely dynamic route segments — this keeps matches honest
 * instead of guessing. */
function segmentsMatch(patternSegs: string[], routeSegs: string[]): boolean {
  let pi = 0;
  for (let ri = 0; ri < routeSegs.length; ri++) {
    const rSeg = routeSegs[ri];
    const catchAll = rSeg.match(/^\[\.\.\.(.+)\]$/);
    if (catchAll) {
      return pi < patternSegs.length; // consumes all remaining pattern segments
    }
    const dynamic = /^\[(.+)\]$/.test(rSeg);
    const pSeg = patternSegs[pi];
    if (pSeg === undefined) return false;
    if (dynamic) {
      pi++;
      continue;
    }
    if (pSeg === "%DYNAMIC%" || pSeg !== rSeg) return false;
    pi++;
  }
  return pi === patternSegs.length;
}

function findMatchingRoute(pattern: string, routes: DetectedRoute[]): DetectedRoute | null {
  const patternSegs = pattern.split("/").filter(Boolean);
  const candidates = routes.filter((r) => segmentsMatch(patternSegs, r.routePath.split("/").filter(Boolean)));
  if (candidates.length === 0) return null;
  // Prefer the most specific (fewest dynamic segments) match.
  candidates.sort((a, b) => (a.routePath.match(/\[/g)?.length ?? 0) - (b.routePath.match(/\[/g)?.length ?? 0));
  return candidates[0];
}

const VALID_OVERRIDES: DiagramNodeStatus[] = ["ACTIVE", "COMING_SOON", "DRAFT", "IN_DEVELOPMENT", "NEEDS_REVIEW"];

async function contentNoteFor(routePath: string): Promise<string | null> {
  try {
    if (routePath === "/exams/[slug]" || routePath === "/admin/exams/[id]/edit") {
      const [active, comingSoon] = await Promise.all([
        prisma.exam.count({ where: { status: "ACTIVE" } }),
        prisma.exam.count({ where: { status: "COMING_SOON" } }),
      ]);
      return `Backs ${active + comingSoon} exam record(s): ${active} active, ${comingSoon} coming soon.`;
    }
    if (routePath === "/test-series/[slug]") {
      const count = await prisma.testSeries.count();
      return `Backs ${count} test series record(s).`;
    }
    if (routePath === "/student/tests/[testId]" || routePath === "/student/tests/[testId]/attempt/[attemptId]") {
      const published = await prisma.test.count({ where: { isPublished: true } });
      return `Backs ${published} published test(s).`;
    }
  } catch {
    return null;
  }
  return null;
}

export async function buildDiagramGraph(): Promise<DiagramGraph> {
  const [routes, fileIndex, nodeMetaRows, plannedRows] = await Promise.all([
    scanRoutes(),
    Promise.resolve(scanLinks()),
    prisma.diagramNodeMeta.findMany(),
    prisma.diagramPlannedPage.findMany(),
  ]);

  const metaByRoute = new Map(nodeMetaRows.map((m) => [m.route, m]));

  // --- Step 1: per-route closures + fan-in -------------------------------------------------
  const routeClosures = new Map<string, Set<string>>();
  for (const route of routes) {
    const absFile = path.join(/*turbopackIgnore: true*/ process.cwd(), route.filePath);
    const seeds = [route.filePath, ...findAncestorLayouts(absFile)];
    routeClosures.set(route.routePath, closureOf(seeds, fileIndex));
  }

  const fanIn = new Map<string, number>();
  for (const closure of routeClosures.values()) {
    for (const file of closure) fanIn.set(file, (fanIn.get(file) ?? 0) + 1);
  }
  const sharedFiles = new Set([...fanIn.entries()].filter(([, n]) => n >= SHARED_FAN_IN_THRESHOLD).map(([f]) => f));

  // --- Step 2: per-route own refs (excluding shared chrome) ---------------------------------
  const ownRefsByRoute = new Map<string, LinkRef[]>();
  for (const route of routes) {
    const closure = routeClosures.get(route.routePath)!;
    const refs: LinkRef[] = [];
    for (const file of closure) {
      if (sharedFiles.has(file)) continue;
      refs.push(...(fileIndex.get(file)?.refs ?? []));
    }
    ownRefsByRoute.set(route.routePath, refs);
  }

  // --- Step 3: shared chrome -> global-nav refs attributed to one representative entry point --
  const publicRefs: LinkRef[] = [];
  const adminRefs: LinkRef[] = [];
  const studentRefs: LinkRef[] = [];
  for (const file of sharedFiles) {
    const refs = fileIndex.get(file)?.refs ?? [];
    if (!refs.length) continue;
    const consumers = routes.filter((r) => routeClosures.get(r.routePath)!.has(file));
    if (consumers.some((r) => r.accessLevel === "Public" || r.accessLevel === "Student")) publicRefs.push(...refs);
    if (consumers.some((r) => r.accessLevel === "Admin")) adminRefs.push(...refs);
  }
  const globalNavByRoute = new Map<string, LinkRef[]>([
    ["/", publicRefs],
    ["/admin/dashboard", adminRefs],
    ["/student/dashboard", studentRefs],
  ]);

  // --- Step 4: resolve refs to edges ---------------------------------------------------------
  const edgesByKey = new Map<string, DiagramEdge>();
  const missingTargets = new Map<string, string>(); // pattern -> synthetic node id
  const brokenBySource = new Map<string, Set<string>>();

  function addEdge(source: string, target: string, kind: DiagramEdge["kind"]) {
    const id = `${source}::${target}::${kind}`;
    if (!edgesByKey.has(id)) edgesByKey.set(id, { id, source, target, kind });
  }

  function resolveAndConnect(source: string, refs: LinkRef[], globalNav: boolean) {
    for (const ref of refs) {
      const pattern = normalizePattern(ref.pattern);
      if (pattern === source) continue; // self-links (e.g. active-tab highlighting) aren't a navigation edge
      const target = findMatchingRoute(pattern, routes);
      if (target) {
        addEdge(source, target.routePath, globalNav ? "global-nav" : ref.kind === "link" ? "link" : ref.kind === "fetch" ? "fetch" : "action");
      } else {
        let missingId = missingTargets.get(pattern);
        if (!missingId) {
          missingId = `missing:${pattern}`;
          missingTargets.set(pattern, missingId);
        }
        addEdge(source, missingId, "broken");
        if (!brokenBySource.has(source)) brokenBySource.set(source, new Set());
        brokenBySource.get(source)!.add(pattern);
      }
    }
  }

  for (const route of routes) resolveAndConnect(route.routePath, ownRefsByRoute.get(route.routePath) ?? [], false);
  for (const [entry, refs] of globalNavByRoute) {
    if (routes.some((r) => r.routePath === entry)) resolveAndConnect(entry, refs, true);
  }

  const edges = [...edgesByKey.values()];

  // --- Step 5: incoming/outgoing per node ----------------------------------------------------
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Set());
    outgoing.get(edge.source)!.add(edge.target);
    if (edge.kind !== "broken") {
      if (!incoming.has(edge.target)) incoming.set(edge.target, new Set());
      incoming.get(edge.target)!.add(edge.source);
    }
  }

  // --- Step 6: build nodes --------------------------------------------------------------------
  const nodes: DiagramNode[] = [];

  for (const route of routes) {
    const meta = metaByRoute.get(route.routePath);
    const isEntryPoint = route.routePath === "/" || route.section === "Authentication";
    const inCount = incoming.get(route.routePath)?.size ?? 0;

    let status: DiagramNodeStatus;
    const override = meta?.statusOverride as DiagramNodeStatus | undefined;
    if (override && VALID_OVERRIDES.includes(override)) {
      status = override;
    } else if (!isEntryPoint && inCount === 0) {
      status = "DISCONNECTED";
    } else {
      status = "ACTIVE";
    }

    nodes.push({
      id: route.routePath,
      route: route.routePath,
      label: meta?.displayName || humanizeRoute(route.routePath),
      section: (meta?.sectionLabel as DiagramSection | undefined) || route.section,
      contentArea: route.contentArea,
      accessLevel: route.accessLevel,
      kind: route.kind,
      status,
      isDynamic: route.isDynamic,
      incoming: [...(incoming.get(route.routePath) ?? [])],
      outgoing: [...(outgoing.get(route.routePath) ?? [])],
      brokenOutgoing: [...(brokenBySource.get(route.routePath) ?? [])],
      notes: meta?.notes ?? null,
      detectionSource:
        route.kind === "api"
          ? "Detected from an app/ API route file (route.ts)."
          : "Detected from an app/ page file (file-system routing).",
      contentNote: await contentNoteFor(route.routePath),
    });
  }

  for (const [pattern, id] of missingTargets) {
    const guessedSection: DiagramSection = pattern.startsWith("/admin")
      ? "Admin Area"
      : pattern.startsWith("/student")
        ? "Student Area"
        : pattern.startsWith("/api")
          ? "API / Backend"
          : "Public Website";
    nodes.push({
      id,
      route: pattern,
      label: pattern,
      section: guessedSection,
      contentArea: "General",
      accessLevel: "Public",
      kind: "missing",
      status: "BROKEN",
      isDynamic: pattern.includes("%DYNAMIC%"),
      incoming: [...edges.filter((e) => e.target === id).map((e) => e.source)],
      outgoing: [],
      brokenOutgoing: [],
      notes: null,
      detectionSource: "Referenced by a link, redirect, or fetch call — no matching route file exists.",
      contentNote: null,
    });
  }

  for (const planned of plannedRows) {
    nodes.push({
      id: `planned:${planned.id}`,
      route: planned.plannedRoute,
      label: planned.label,
      section: (planned.section as DiagramSection) || "Public Website",
      contentArea: "General",
      accessLevel: "Public",
      kind: "planned",
      status: "COMING_SOON",
      isDynamic: false,
      incoming: [],
      outgoing: [],
      brokenOutgoing: [],
      notes: planned.notes,
      detectionSource: "Admin-entered planned page — not yet implemented in the codebase.",
      contentNote: null,
    });
  }

  const summary: DiagramSummary = {
    totalPages: nodes.filter((n) => n.kind === "page" || n.kind === "api").length,
    activePages: nodes.filter((n) => n.status === "ACTIVE").length,
    comingSoon: nodes.filter((n) => n.status === "COMING_SOON").length,
    draftOrInDevelopment: nodes.filter((n) => n.status === "DRAFT" || n.status === "IN_DEVELOPMENT").length,
    brokenLinks: [...missingTargets.values()].length,
    disconnectedPages: nodes.filter((n) => n.status === "DISCONNECTED").length,
    needsReview: nodes.filter((n) => n.status === "NEEDS_REVIEW").length,
  };

  return { nodes, edges, summary, generatedAt: new Date().toISOString() };
}
