import "server-only";
import fs from "node:fs";
import path from "node:path";

/**
 * Literal hrefs inside shared chrome (header/footer/sidebar) are deliberately
 * NOT turned into page-to-page graph edges — they render on many pages at
 * once, so attaching them to one "from" page would misrepresent the graph.
 * They're real navigation though, so they're surfaced here as a flat list per
 * shared component instead.
 */
const GLOBAL_NAV_FILES: { label: string; file: string }[] = [
  { label: "Public Site Header", file: "components/homepage/site-header.tsx" },
  { label: "Public Site Footer", file: "components/homepage/site-footer.tsx" },
  { label: "Student Header", file: "components/student/header.tsx" },
  { label: "Admin Sidebar", file: "components/admin/sidebar.tsx" },
  { label: "Admin Header", file: "components/admin/header.tsx" },
];

const HREF_LITERAL = /\bhref\s*=\s*"(\/[a-zA-Z0-9\-_/[\]]*)"/g;

export interface GlobalNavGroup {
  label: string;
  file: string;
  links: string[];
}

export function scanGlobalNavLinks(): GlobalNavGroup[] {
  const root = process.cwd();
  return GLOBAL_NAV_FILES.map(({ label, file }) => {
    let source = "";
    try {
      source = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      return { label, file, links: [] };
    }
    const links = new Set<string>();
    HREF_LITERAL.lastIndex = 0;
    for (const m of source.matchAll(HREF_LITERAL)) links.add(m[1]);
    return { label, file, links: [...links] };
  }).filter((g) => g.links.length > 0);
}
