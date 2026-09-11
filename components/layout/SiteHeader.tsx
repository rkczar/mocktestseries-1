import type { AnnouncementDTO } from "@/lib/content/types";

import { AnnouncementBar } from "./AnnouncementBar";
import { Logo } from "./Logo";
import { MobileNav } from "./MobileNav";
import { ModeToggle } from "./ModeToggle";
import { NavLink } from "./NavLink";
import { NAV_ITEMS } from "./nav-items";

export function SiteHeader({ announcement }: { announcement: AnnouncementDTO | null }) {
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
            <ModeToggle />
            <MobileNav />
          </div>
        </div>
      </header>
    </>
  );
}
