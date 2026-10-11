import { MAX_SLIDES, type PostContent, type SlideModule } from "@/lib/instagram/types";

/**
 * Smart slide count: build the carousel from the content that actually exists
 * instead of forcing all seven slides. Order follows the universal carousel:
 * Question → Answer → Diagram → Pearls → Common Mistakes → Examiner Trap → Follow.
 * A rejected trap and empty sections are left out; the Answer slide carries the
 * explanation when there is no separate explanation slide.
 */
export function smartModules(c: PostContent, opts: { includeHook?: boolean } = {}): SlideModule[] {
  const m: SlideModule[] = [];
  if (opts.includeHook && c.hookText.trim()) m.push("HOOK");
  m.push("QUESTION", "ANSWER");
  if (c.diagram) m.push("DIAGRAM");
  if (c.pearls.length) m.push("PEARLS");
  else if (c.clinicalPearl.trim() && c.quickRevision.length) m.push("PEARL_REVISION");
  if (c.mistakes.length) m.push("MISTAKES");
  if (c.trap && c.trap.status !== "rejected") m.push("TRAP");
  // Only an image the admin already approved (Add to Carousel) — a pending preview is never added.
  if (c.medicalImage) m.push("MEDICAL_IMAGE");
  m.push("FOLLOW");
  // At most 9 modules exist, so this never trims today; kept as a guard for Instagram's limit.
  return m.length > MAX_SLIDES ? [...m.slice(0, MAX_SLIDES - 1), "FOLLOW"] : m;
}
