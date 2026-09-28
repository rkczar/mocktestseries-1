/**
 * Renders admin-authored legal text (Privacy Policy / Terms & Conditions /
 * Refund & Cancellation Policy). A line starting with "## " renders as a
 * subheading — any lines after it in the same block are its paragraph. A
 * block whose lines all start with "- " renders as a bullet list; everything
 * else is a plain paragraph. No HTML/markdown parsing — output is always
 * plain text inside React elements, so admin-authored content can never
 * inject markup.
 */
type Node = { kind: "h"; text: string } | { kind: "p"; text: string; closed?: boolean } | { kind: "ul"; items: string[]; closed?: boolean };

function parse(text: string): Node[] {
  const out: Node[] = [];
  // Consecutive "- " lines form one list; other consecutive lines form one paragraph.
  const pushBody = (body: string) => {
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const last = out[out.length - 1];
      if (t.startsWith("- ")) {
        if (last?.kind === "ul" && !last.closed) last.items.push(t.slice(2).trim());
        else out.push({ kind: "ul", items: [t.slice(2).trim()] });
      } else if (last?.kind === "p" && !last.closed) last.text += `\n${line}`;
      else out.push({ kind: "p", text: line });
    }
    const last = out[out.length - 1];
    if (last && last.kind !== "h") last.closed = true;
  };
  for (const block of text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)) {
    if (block.startsWith("## ")) {
      const nl = block.indexOf("\n");
      out.push({ kind: "h", text: (nl === -1 ? block : block.slice(0, nl)).slice(3).trim() });
      if (nl !== -1) pushBody(block.slice(nl + 1).trim());
    } else {
      pushBody(block);
    }
  }
  return out;
}

export function LegalBody({ text }: { text: string }) {
  const nodes = parse(text);

  if (nodes.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">This document is being updated. Please contact us if you need a copy.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {nodes.map((n, i) => {
        if (n.kind === "h") {
          return (
            <h3 key={i} className="text-base font-semibold text-[var(--color-foreground)]">
              {n.text}
            </h3>
          );
        }
        if (n.kind === "ul") {
          return (
            <ul key={i} className="flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
              {n.items.map((it, j) => (
                <li key={j}>{it}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-muted-foreground)]">
            {n.text}
          </p>
        );
      })}
    </div>
  );
}
