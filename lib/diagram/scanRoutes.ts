import "server-only";

import { promises as fs } from "fs";
import path from "path";

import type { DiagramAccessLevel, DiagramContentArea, DiagramSection } from "./types";

/**
 * A single route detected directly from the app/ directory — one page.tsx or route.ts file.
 * This is the only place routes are enumerated; nothing here is a hand-maintained list, so a
 * newly added page.tsx is picked up automatically the next time the diagram is refreshed.
 */
export interface DetectedRoute {
  routePath: string; // e.g. "/exams/[slug]"
  filePath: string; // repo-relative, e.g. "app/(public)/exams/[slug]/page.tsx" — never shown in the UI
  kind: "page" | "api";
  isDynamic: boolean;
  section: DiagramSection;
  contentArea: DiagramContentArea;
  accessLevel: DiagramAccessLevel;
}

const APP_ROOT = path.join(process.cwd(), "app");

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (entry.name === "page.tsx" || entry.name === "route.ts") {
      files.push(full);
    }
  }
  return files;
}

/** Converts an app/ file path into its URL route, stripping route groups like "(public)". */
function fileToRoute(absFilePath: string): string {
  const relToApp = path.relative(APP_ROOT, absFilePath);
  const segments = relToApp
    .split(path.sep)
    .slice(0, -1) // drop page.tsx / route.ts
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")"))); // drop route groups

  if (segments.length === 0) return "/";
  return "/" + segments.join("/");
}

function classify(routePath: string): {
  section: DiagramSection;
  contentArea: DiagramContentArea;
  accessLevel: DiagramAccessLevel;
} {
  if (routePath === "/admin/login") return { section: "Authentication", contentArea: "General", accessLevel: "Admin" };
  if (routePath.startsWith("/admin")) {
    const contentArea: DiagramContentArea = routePath.includes("/exams")
      ? "Exams"
      : routePath.includes("/test-series") || routePath.includes("/questions")
        ? "Tests"
        : "General";
    return { section: "Admin Area", contentArea, accessLevel: "Admin" };
  }

  if (routePath === "/student/login" || routePath === "/student/register") {
    return { section: "Authentication", contentArea: "General", accessLevel: "Student" };
  }
  if (routePath.startsWith("/student/tests")) {
    return { section: "Test Player", contentArea: "Tests", accessLevel: "Student" };
  }
  if (routePath.startsWith("/student")) {
    return { section: "Student Area", contentArea: "General", accessLevel: "Student" };
  }

  if (routePath.startsWith("/api/auth")) {
    return { section: "Authentication", contentArea: "General", accessLevel: "System" };
  }
  if (routePath.startsWith("/api/ai")) {
    return { section: "AI", contentArea: "AI", accessLevel: "System" };
  }
  if (routePath.startsWith("/api")) {
    return { section: "API / Backend", contentArea: "General", accessLevel: "System" };
  }

  const contentArea: DiagramContentArea = routePath.startsWith("/exams")
    ? "Exams"
    : routePath.startsWith("/test-series")
      ? "Tests"
      : "General";
  return { section: "Public Website", contentArea, accessLevel: "Public" };
}

export async function scanRoutes(): Promise<DetectedRoute[]> {
  const files = await walk(APP_ROOT);
  const routes: DetectedRoute[] = [];

  for (const absFilePath of files) {
    const routePath = fileToRoute(absFilePath);
    const filePath = path.relative(process.cwd(), absFilePath);
    const kind: "page" | "api" = absFilePath.endsWith("route.ts") ? "api" : "page";
    const isDynamic = /\[[^\]]+\]/.test(routePath);
    const { section, contentArea, accessLevel } = classify(routePath);

    routes.push({ routePath, filePath, kind, isDynamic, section, contentArea, accessLevel });
  }

  return routes.sort((a, b) => a.routePath.localeCompare(b.routePath));
}
