"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { ADMIN_NAV, isNavItemActive } from "@/lib/admin-nav";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const SIDEBAR_COOKIE = "admin_sidebar_collapsed";

function setSidebarCookie(collapsed: boolean) {
  document.cookie = `${SIDEBAR_COOKIE}=${collapsed ? "1" : "0"}; path=/; max-age=31536000`;
}

function NavLink({
  item,
  pathname,
  collapsed,
  onNavigate,
}: {
  item: (typeof ADMIN_NAV)[number];
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const active = isNavItemActive(pathname, item.href);
  const Icon = item.icon;

  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium transition-colors",
        collapsed && "justify-center px-0",
        active
          ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
          : "text-[var(--color-foreground)] hover:bg-[var(--color-surface)]"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
    </Link>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function SidebarContent({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 p-3" aria-label="Admin navigation">
      {ADMIN_NAV.map((item) => (
        <NavLink key={item.href} item={item} pathname={pathname} collapsed={collapsed} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}

export function Sidebar({ defaultCollapsed = false }: { defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      setSidebarCookie(next);
      return next;
    });
  }

  return (
    <TooltipProvider delayDuration={200}>
      <aside
        className={cn(
          "hidden shrink-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-card)] lg:block",
          collapsed ? "w-16" : "w-64"
        )}
      >
        <div
          className={cn(
            "flex items-center border-b border-[var(--color-border)] p-2",
            collapsed ? "justify-center" : "justify-end"
          )}
        >
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="rounded-[var(--radius-button)] p-1.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface)] hover:text-[var(--color-foreground)]"
          >
            {collapsed ? (
              <ChevronsRight className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronsLeft className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>
        <SidebarContent collapsed={collapsed} />
      </aside>
    </TooltipProvider>
  );
}

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div className="absolute left-0 top-0 h-full w-72 overflow-y-auto bg-[var(--color-card)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] p-3">
          <span className="text-sm font-semibold text-[var(--color-foreground)]">Menu</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="rounded-[var(--radius-button)] p-1.5 hover:bg-[var(--color-surface)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <SidebarContent collapsed={false} onNavigate={onClose} />
      </div>
    </div>
  );
}
