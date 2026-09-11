import type { AnnouncementDTO, CtaButtonDTO } from "@/lib/content/types";

import { AnnouncementBar } from "./AnnouncementBar";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";
import { NavLink } from "./NavLink";
import { NAV_ITEMS } from "./nav-items";

const FALLBACK_REGISTER_CTA: CtaButtonDTO = {
  label: "Start Free",
  href: "/student/register",
  variant: "primary",
};

export function SiteHeader({
  announcement,
  headerPrimaryCta,
}: {
  announcement: AnnouncementDTO | null;
  headerPrimaryCta?: CtaButtonDTO;
}) {
  const registerCta = headerPrimaryCta ?? FALLBACK_REGISTER_CTA;

  return (
    <>
      <AnnouncementBar announcement={announcement} />
      <header className="sticky top-0 z-50 border-b border-border bg-surface">
        <div className="mx-auto flex h-[72px] max-w-[1200px] items-center gap-6 px-6">
          <Logo />
          <nav className="ml-2 hidden min-w-0 flex-1 items-center gap-1 lg:flex">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex flex-none items-center gap-2.5">
            <a
              href="/student/login"
              className="hidden rounded-[9px] border border-border-strong px-4 py-2.5 text-[14.5px] font-bold whitespace-nowrap text-primary transition-colors duration-150 hover:bg-accent sm:inline-flex"
            >
              Login
            </a>
            <a
              href={registerCta.href}
              className="inline-flex rounded-[9px] bg-primary px-[18px] py-[11px] text-[14.5px] font-bold whitespace-nowrap text-primary-foreground transition-colors duration-150 hover:bg-primary-hover"
            >
              {registerCta.label}
            </a>
            <MobileNav registerCta={registerCta} />
          </div>
        </div>
      </header>
    </>
  );
}
