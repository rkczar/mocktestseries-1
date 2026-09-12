"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, LogOut } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { MobileSidebar } from "@/components/admin/sidebar";
import { ADMIN_NAV } from "@/lib/admin-nav";
import { logoutAction } from "@/app/admin/(dashboard)/actions";

function useBreadcrumb(pathname: string) {
  for (const group of ADMIN_NAV) {
    const item = group.items.find((i) => i.href === pathname);
    if (item) return [group.label, item.label];
  }
  return ["Admin"];
}

export function AdminHeader({ adminName, role }: { adminName: string; role: string }) {
  const pathname = usePathname();
  const crumbs = useBreadcrumb(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-card)] px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-[var(--radius-button)] p-1.5 hover:bg-[var(--color-surface)] lg:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <nav aria-label="Breadcrumb" className="text-sm text-[var(--color-muted-foreground)]">
            {crumbs.join(" / ")}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggle />
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-[var(--color-foreground)]">{adminName}</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">{role.replace("_", " ")}</p>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              aria-label="Logout"
              title="Logout"
              className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-button)] border border-[var(--color-border)] text-[var(--color-foreground)] hover:bg-[var(--color-surface)]"
            >
              <LogOut className="h-4 w-4" aria-hidden />
            </button>
          </form>
        </div>
      </header>
      <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  );
}
