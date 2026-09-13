import Link from "next/link";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { str, pairs } from "./content-helpers";

export function SiteHeader({ content }: { content: Record<string, unknown> }) {
  const logoText = str(content, "logoText", "Mock Test Series.in");
  const navItems = pairs(content, "navItems");
  const loginHref = str(content, "loginHref", "/login");
  const loginButtonText = str(content, "loginButtonText", "Login");
  const loginButtonVisible = content.loginButtonVisible !== false;

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-background)]/90 backdrop-blur supports-[backdrop-filter]:bg-[var(--color-background)]/70">
      <div className="mx-auto flex h-[4.5rem] w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="shrink-0 text-base font-semibold tracking-tight text-[var(--color-foreground)] sm:text-lg"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          {logoText}
        </Link>

        {navItems.length > 0 ? (
          <nav className="hidden flex-1 items-center justify-center gap-7 md:flex" aria-label="Primary">
            {navItems.map(([label, href]) => (
              <Link
                key={href}
                href={href}
                className="text-sm text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-foreground)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] focus-visible:rounded-sm"
              >
                {label}
              </Link>
            ))}
          </nav>
        ) : (
          <span className="flex-1" />
        )}

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <ThemeToggle />
          {loginButtonVisible ? (
            <Button asChild size="sm" variant="secondary" className="hidden sm:inline-flex">
              <Link href={loginHref}>{loginButtonText}</Link>
            </Button>
          ) : null}
        </div>
      </div>

      {navItems.length > 0 ? (
        <nav
          className="flex items-center gap-4 overflow-x-auto border-t border-[var(--color-border)] px-4 py-2 md:hidden"
          aria-label="Primary"
        >
          {navItems.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className="shrink-0 text-sm font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              {label}
            </Link>
          ))}
          {loginButtonVisible ? (
            <Link href={loginHref} className="shrink-0 text-sm font-semibold text-[var(--color-primary)]">
              {loginButtonText}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}
