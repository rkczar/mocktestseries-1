import "server-only";

import fs from "fs";
import path from "path";

export type LinkRefKind = "link" | "action" | "fetch";

export interface LinkRef {
  kind: LinkRefKind;
  /** Raw target with template placeholders normalized to "%DYNAMIC%" (one per interpolation). */
  pattern: string;
}

export interface FileInfo {
  /** Repo-relative path, e.g. "components/layout/SiteHeader.tsx". Never shown in the UI. */
  filePath: string;
  /** Repo-relative paths of local project files this file imports. */
  imports: string[];
  refs: LinkRef[];
}

const ROOTS = ["app", "components", "lib"];
const SOURCE_EXT = new Set([".ts", ".tsx"]);

const IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']/g;

const REF_PATTERNS: { kind: LinkRefKind; regex: RegExp }[] = [
  { kind: "link", regex: /\bhref\s*=\s*"([^"]+)"/g },
  { kind: "link", regex: /\bhref\s*=\s*'([^']+)'/g },
  { kind: "link", regex: /\bhref\s*=\s*\{\s*`([^`]*)`\s*\}/g },
  { kind: "link", regex: /\bhref\s*:\s*"([^"]+)"/g },
  { kind: "link", regex: /\bhref\s*:\s*'([^']+)'/g },
  { kind: "link", regex: /\bhref\s*:\s*`([^`]*)`/g },
  { kind: "action", regex: /\bredirect\(\s*"([^"]+)"/g },
  { kind: "action", regex: /\bredirect\(\s*'([^']+)'/g },
  { kind: "action", regex: /\bredirect\(\s*`([^`]*)`/g },
  { kind: "action", regex: /\brouter\.push\(\s*"([^"]+)"/g },
  { kind: "action", regex: /\brouter\.push\(\s*'([^']+)'/g },
  { kind: "action", regex: /\brouter\.push\(\s*`([^`]*)`/g },
  { kind: "fetch", regex: /\bfetch\(\s*"([^"]+)"/g },
  { kind: "fetch", regex: /\bfetch\(\s*'([^']+)'/g },
  { kind: "fetch", regex: /\bfetch\(\s*`([^`]*)`/g },
];

function walkAll(dir: string, files: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAll(full, files);
    } else if (SOURCE_EXT.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function resolveImport(fromFileAbs: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) {
    base = path.join(/*turbopackIgnore: true*/ process.cwd(), specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.join(path.dirname(fromFileAbs), specifier);
  } else {
    return null; // external package — not part of this app's own architecture
  }

  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(/*turbopackIgnore: true*/ candidate) && fs.statSync(/*turbopackIgnore: true*/ candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/** Normalizes a template literal's ${...} interpolations into a single wildcard token. */
function normalizeTemplate(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, "%DYNAMIC%");
}

function extractRefs(source: string): LinkRef[] {
  const refs: LinkRef[] = [];
  for (const { kind, regex } of REF_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source))) {
      const raw = match[1];
      if (!raw || !raw.startsWith("/")) continue; // internal-only: mailto:, tel:, external, "#", etc. excluded
      if (raw.startsWith("/_next") || raw.startsWith("//")) continue;
      refs.push({ kind, pattern: normalizeTemplate(raw) });
    }
  }
  return refs;
}

/** Scans app/, components/, and lib/ once and returns a per-file index of imports + outgoing refs. */
export function scanLinks(): Map<string, FileInfo> {
  const cwd = process.cwd();
  const allAbsFiles = ROOTS.flatMap((root) => walkAll(path.join(/*turbopackIgnore: true*/ cwd, root)));
  const index = new Map<string, FileInfo>();

  for (const absFile of allAbsFiles) {
    const filePath = path.relative(cwd, absFile);
    let source: string;
    try {
      source = fs.readFileSync(absFile, "utf8");
    } catch {
      continue;
    }

    const imports = new Set<string>();
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(source))) {
      const resolved = resolveImport(absFile, match[1]);
      if (resolved) imports.add(path.relative(cwd, resolved));
    }

    index.set(filePath, { filePath, imports: [...imports], refs: extractRefs(source) });
  }

  return index;
}
