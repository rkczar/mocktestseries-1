import "server-only";
import { readEntry, readZipDirectory, type OfficeEntry } from "@/lib/ai-import/zip-peek";
import type { Line } from "@/lib/ai-import/local-parse";

/**
 * DOCX reading for the AI Question Importer — the XML is parsed as DATA:
 * text runs, tabs/breaks, Word auto-numbering, tables, inline images
 * (r:embed → word/media/*, exact original bytes) and equations. No macros,
 * fields or external links are ever evaluated; only parts inside the
 * container are read.
 *
 * Every image becomes an inline token ⟦IMG:n⟧ at its exact position in the
 * text, so the question/option it belongs to is known precisely.
 * Sub/superscript runs and Word equations (OMML) become KaTeX notation
 * ($…$) and the question is marked RICH_V1 — notation is preserved, not
 * guessed; constructs we cannot convert are flagged.
 */

export interface DocxMedia {
  token: string;
  part: string;
  bytes: Buffer;
  ext: string;
}

export interface DocxContent {
  lines: Line[];
  media: DocxMedia[];
  /** Lines that contain converted notation ($…$). */
  richLines: number;
  /** Equation constructs that could not be converted (kept as their plain text). */
  unconvertedMath: number;
  /** Images referenced from outside the package (never fetched). */
  externalImages: number;
  paragraphs: number;
}

export const IMG_TOKEN = /⟦IMG:(\d+)⟧/g;

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");

interface NumLevel {
  fmt: string;
  text: string;
  start: number;
}

function parseNumbering(xml: string | null): Map<string, Map<number, NumLevel>> {
  const out = new Map<string, Map<number, NumLevel>>();
  if (!xml) return out;
  const abstract = new Map<string, Map<number, NumLevel>>();
  for (const a of xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const levels = new Map<number, NumLevel>();
    for (const l of a[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      levels.set(Number(l[1]), {
        fmt: /<w:numFmt w:val="([^"]+)"/.exec(l[2])?.[1] ?? "decimal",
        text: decode(/<w:lvlText w:val="([^"]*)"/.exec(l[2])?.[1] ?? "%1."),
        start: Number(/<w:start w:val="(\d+)"/.exec(l[2])?.[1] ?? 1),
      });
    }
    abstract.set(a[1], levels);
  }
  for (const n of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abs = /<w:abstractNumId w:val="(\d+)"/.exec(n[2])?.[1];
    if (abs && abstract.has(abs)) out.set(n[1], abstract.get(abs)!);
  }
  return out;
}

function formatNumber(n: number, fmt: string): string {
  if (fmt === "lowerLetter") return String.fromCharCode(96 + ((n - 1) % 26) + 1);
  if (fmt === "upperLetter") return String.fromCharCode(64 + ((n - 1) % 26) + 1);
  if (fmt === "lowerRoman" || fmt === "upperRoman") {
    const r = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"][n] ?? String(n);
    return fmt === "upperRoman" ? r.toUpperCase() : r;
  }
  return String(n);
}

// ---- Equations (OMML → LaTeX, common constructs only) -------------------------------------------

function ommlToLatex(xml: string, stats: { unconverted: number }): string {
  const inner = (tag: string, s: string) => new RegExp(`<m:${tag}\\b[^>]*>([\\s\\S]*?)<\\/m:${tag}>`).exec(s)?.[1] ?? "";
  const walk = (s: string): string => {
    let out = "";
    const re = /<m:(f|sSup|sSub|sSubSup|rad|r|d|nary|e)\b[^>]*>([\s\S]*?)<\/m:\1>/g;
    let m: RegExpExecArray | null;
    let last = 0;
    while ((m = re.exec(s))) {
      out += s.slice(last, m.index).replace(/<[^>]+>/g, "");
      const body = m[2];
      switch (m[1]) {
        case "f":
          out += `\\frac{${walk(inner("num", body))}}{${walk(inner("den", body))}}`;
          break;
        case "sSup":
          out += `{${walk(inner("e", body))}}^{${walk(inner("sup", body))}}`;
          break;
        case "sSub":
          out += `{${walk(inner("e", body))}}_{${walk(inner("sub", body))}}`;
          break;
        case "sSubSup":
          out += `{${walk(inner("e", body))}}_{${walk(inner("sub", body))}}^{${walk(inner("sup", body))}}`;
          break;
        case "rad": {
          const deg = walk(inner("deg", body));
          out += deg ? `\\sqrt[${deg}]{${walk(inner("e", body))}}` : `\\sqrt{${walk(inner("e", body))}}`;
          break;
        }
        case "r":
          out += [...body.matchAll(/<m:t\b[^>]*>([\s\S]*?)<\/m:t>/g)].map((t) => escapeLatexText(decode(t[1]))).join("");
          break;
        case "d":
          out += `\\left(${walk(body)}\\right)`;
          break;
        case "e":
          out += walk(body);
          break;
        default:
          stats.unconverted++;
          out += walk(body);
      }
      last = re.lastIndex;
    }
    return out + s.slice(last).replace(/<[^>]+>/g, "");
  };
  return walk(xml).trim();
}

function escapeLatexText(s: string): string {
  return s.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/[$%#&_]/g, (c) => `\\${c}`).replace(/[−]/g, "-");
}

/** Escapes a literal "$" in plain text so a RICH_V1 question never opens a formula by accident. */
function escapeDollar(s: string): string {
  return s.replace(/\$/g, "\\$");
}

// ---- Paragraph text ------------------------------------------------------------------------------

interface ParaCtx {
  rels: Map<string, { target: string; external: boolean }>;
  mediaByPart: Map<string, DocxMedia>;
  media: DocxMedia[];
  entries: Map<string, OfficeEntry>;
  file: string;
  stats: { unconverted: number; external: number };
}

async function paragraphText(xml: string, ctx: ParaCtx): Promise<{ text: string; rich: boolean }> {
  let text = "";
  let rich = false;
  const re = /<m:oMathPara\b[\s\S]*?<\/m:oMathPara>|<m:oMath\b[\s\S]*?<\/m:oMath>|<w:r\b[^>]*>[\s\S]*?<\/w:r>|<w:hyperlink\b[^>]*>|<w:tab\/>|<w:br\/>/g;
  for (const m of xml.matchAll(re)) {
    const part = m[0];
    if (part.startsWith("<m:oMath")) {
      text += ` $${ommlToLatex(part, ctx.stats)}$ `;
      rich = true;
      continue;
    }
    if (part === "<w:tab/>") {
      text += "  ";
      continue;
    }
    if (part === "<w:br/>") {
      text += "\n";
      continue;
    }
    if (!part.startsWith("<w:r")) continue;
    const vert = /<w:vertAlign w:val="(superscript|subscript)"/.exec(part)?.[1];
    for (const piece of part.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:drawing>[\s\S]*?<\/w:drawing>|<w:pict>[\s\S]*?<\/w:pict>/g)) {
      const p = piece[0];
      if (p === "<w:tab/>") text += "  ";
      else if (p === "<w:br/>") text += "\n";
      else if (p.startsWith("<w:drawing") || p.startsWith("<w:pict")) {
        const rid = /r:(?:embed|id)="([^"]+)"/.exec(p)?.[1];
        const rel = rid ? ctx.rels.get(rid) : undefined;
        if (!rel || rel.external) {
          ctx.stats.external++;
          text += " ⟦IMG:missing⟧ ";
          continue;
        }
        const partName = rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target}`.replace(/\/\.\//g, "/");
        let media = ctx.mediaByPart.get(partName);
        if (!media) {
          const entry = ctx.entries.get(partName);
          const ext = (/\.([a-z0-9]+)$/i.exec(partName)?.[1] ?? "").toLowerCase();
          if (!entry || !["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "emf", "wmf"].includes(ext)) {
            ctx.stats.external++;
            text += " ⟦IMG:missing⟧ ";
            continue;
          }
          media = { token: String(ctx.media.length + 1), part: partName, bytes: await readEntry(ctx.file, entry, 16 * 1024 * 1024), ext };
          ctx.media.push(media);
          ctx.mediaByPart.set(partName, media);
        }
        text += ` ⟦IMG:${media.token}⟧ `;
      } else {
        const t = decode(piece[1] ?? "");
        if (vert && t.trim()) {
          text += vert === "superscript" ? `$^{${escapeLatexText(t)}}$` : `$_{${escapeLatexText(t)}}$`;
          rich = true;
        } else text += t;
      }
    }
  }
  return { text, rich };
}

/** Reads a DOCX into reading-ordered lines (paragraphs; table rows joined cell by cell) + its images. */
export async function readDocx(file: string): Promise<DocxContent> {
  const entries = new Map((await readZipDirectory(file)).map((e) => [e.name, e]));
  const doc = entries.get("word/document.xml");
  if (!doc) throw new Error("word/document.xml is missing.");
  const xml = (await readEntry(file, doc, 32 * 1024 * 1024)).toString("utf8");
  const relsEntry = entries.get("word/_rels/document.xml.rels");
  const rels = new Map<string, { target: string; external: boolean }>();
  if (relsEntry) {
    const r = (await readEntry(file, relsEntry, 4 * 1024 * 1024)).toString("utf8");
    for (const m of r.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = /Id="([^"]+)"/.exec(m[1])?.[1];
      const target = /Target="([^"]+)"/.exec(m[1])?.[1];
      if (id && target) rels.set(id, { target: decode(target), external: /TargetMode="External"/.test(m[1]) });
    }
  }
  const numEntry = entries.get("word/numbering.xml");
  const numbering = parseNumbering(numEntry ? (await readEntry(file, numEntry, 4 * 1024 * 1024)).toString("utf8") : null);
  const counters = new Map<string, number[]>();

  const ctx: ParaCtx = { rels, mediaByPart: new Map(), media: [], entries, file, stats: { unconverted: 0, external: 0 } };
  const lines: Line[] = [];
  let richLines = 0;
  let paragraphs = 0;

  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? "";
  const blocks = body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g);
  const para = async (p: string): Promise<{ text: string; rich: boolean }> => {
    paragraphs++;
    const { text, rich } = await paragraphText(p, ctx);
    let prefix = "";
    const numId = /<w:numId w:val="(\d+)"/.exec(p)?.[1];
    if (numId && numId !== "0" && numbering.has(numId)) {
      const ilvl = Number(/<w:ilvl w:val="(\d+)"/.exec(p)?.[1] ?? 0);
      const levels = numbering.get(numId)!;
      const lvl = levels.get(ilvl);
      const c = counters.get(numId) ?? [];
      c[ilvl] = (c[ilvl] ?? (lvl?.start ?? 1) - 1) + 1;
      for (let i = ilvl + 1; i < c.length; i++) c[i] = (levels.get(i)?.start ?? 1) - 1;
      counters.set(numId, c);
      if (lvl && lvl.fmt !== "bullet" && lvl.fmt !== "none") {
        prefix = lvl.text.replace(/%(\d)/g, (_, k) => formatNumber(c[Number(k) - 1] ?? 1, (levels.get(Number(k) - 1) ?? lvl).fmt)) + " ";
      }
    }
    return { text: (prefix + (rich ? escapeDollarOutsideMath(text) : text)).replace(/[ \t]+/g, " ").trim(), rich };
  };
  for (const m of blocks) {
    const part = m[0];
    if (part.startsWith("<w:tbl")) {
      for (const row of part.matchAll(/<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g)) {
        const cells: string[] = [];
        let rowRich = false;
        for (const cell of row[0].matchAll(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g)) {
          const ps: string[] = [];
          for (const p of cell[0].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
            const r = await para(p[0]);
            rowRich ||= r.rich;
            if (r.text) ps.push(r.text);
          }
          cells.push(ps.join(" "));
        }
        const text = cells.filter(Boolean).join("  ");
        if (text) {
          // Each table row becomes its own line(s) so "1." / "(A)" cells keep their structure.
          for (const t of text.split("\n")) lines.push({ text: t });
          if (rowRich) richLines++;
        }
      }
      continue;
    }
    const r = await para(part);
    if (!r.text) continue;
    for (const t of r.text.split("\n")) lines.push({ text: t });
    if (r.rich) richLines++;
  }
  return { lines, media: ctx.media, richLines, unconvertedMath: ctx.stats.unconverted, externalImages: ctx.stats.external, paragraphs };
}

/** In a paragraph that carries $…$ notation, literal dollar signs outside math are escaped. */
function escapeDollarOutsideMath(text: string): string {
  // Notation we generated is always "$…$" with no "$" inside; split on it and escape the rest.
  const parts = text.split(/(\$[^$]*\$)/g);
  return parts.map((p, i) => (i % 2 === 1 ? p : escapeDollar(p))).join("");
}
