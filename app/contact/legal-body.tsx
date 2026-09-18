/**
 * Renders admin-authored legal text (Privacy Policy / Terms & Conditions).
 * A line starting with "## " renders as a subheading; everything else is a
 * plain paragraph. No HTML/markdown parsing — output is always plain text
 * inside React elements, so admin-authored content can never inject markup.
 */
export function LegalBody({ text }: { text: string }) {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return <p className="text-sm text-[var(--color-muted-foreground)]">Content coming soon.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {blocks.map((block, i) => {
        if (block.startsWith("## ")) {
          return (
            <h3 key={i} className="text-base font-semibold text-[var(--color-foreground)]">
              {block.slice(3).trim()}
            </h3>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-muted-foreground)]">
            {block}
          </p>
        );
      })}
    </div>
  );
}
