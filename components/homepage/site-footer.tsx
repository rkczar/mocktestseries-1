import Link from "next/link";
import { str, pairs } from "./content-helpers";
import type { ResolvedHomepage } from "@/lib/homepage-render";
import { BrandLogo } from "@/components/brand/BrandLogo";
import { BRAND_NAME } from "@/lib/brand";
import { GrowWithUsButton } from "./grow-with-us";

export function SiteFooter({
  content,
  resolved,
  growWithUsEnabled = false,
}: {
  content: Record<string, unknown>;
  resolved: ResolvedHomepage["sections"][number]["resolved"];
  growWithUsEnabled?: boolean;
}) {
  const email = str(content, "email");
  const location = str(content, "location");
  const instagramUrl = str(content, "instagramUrl");
  const links = pairs(content, "links");
  const copyrightLine = resolved.copyrightLine || `© ${new Date().getFullYear()} ${BRAND_NAME}`;

  return (
    <footer className="border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <BrandLogo size="md" href={null} />
          {location ? <p className="text-sm text-[var(--color-muted-foreground)]">{location}</p> : null}
          {email ? (
            <a href={`mailto:${email}`} className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
              {email}
            </a>
          ) : null}
          {instagramUrl ? (
            <a
              href={instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              Instagram
            </a>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          {links.length > 0 ? (
            <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Footer">
              {links.map(([label, href]) => (
                <Link
                  key={href}
                  href={href}
                  className="text-sm text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] focus-visible:rounded-sm"
                >
                  {label}
                </Link>
              ))}
            </nav>
          ) : null}
          {growWithUsEnabled ? <GrowWithUsButton variant="secondary" className="self-start" /> : null}
        </div>
      </div>
      <p className="border-t border-[var(--color-border)] px-4 py-4 text-center text-xs text-[var(--color-muted-foreground)] sm:px-6">
        {copyrightLine}
      </p>
    </footer>
  );
}