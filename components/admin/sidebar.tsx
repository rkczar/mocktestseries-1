"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, X } from "lucide-react";
import { ADMIN_NAV } from "@/lib/admin-nav";
import { cn } from "@/lib/utils";

function NavGroup({
  group,
  pathname,
  onNavigate,
}: {
  group: (typeof ADMIN_NAV)[number];
  pathname: string;
  onNavigate?: () => void;
}) {
  const isGroupActive = group.items.some((item) => pathname === item.href);
  const [open, setOpen] = useState(isGroupActive || group.items.length === 1);
  const Icon = group.icon;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center justify-between rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium transition-colors",
          isGroupActive
            ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
            : "text-[var(--color-foreground)] hover:bg-[var(--color-surface)]"
        )}
      >
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4" aria-hidden />
          {group.label}
        </span>
        {group.items.length > 1 ? (
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden />
        ) : null}
      </button>
      {open && group.items.length > 1 ? (
        <div className="mt-1 flex flex-col gap-0.5 border-l border-[var(--color-border)] pl-4">
          {group.items.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center justify-between rounded-[var(--radius-button)] px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-[var(--color-primary)]/10 font-medium text-[var(--color-primary)]"
                    : "text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface)] hover:text-[var(--color-foreground)]"
                )}
              >
                {item.label}
                {item.status === "draft" ? (
                  <span className="rounded-full bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
                    Soon
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
      {group.items.length === 1 ? (
        <Link
          href={group.items[0].href}
          onClick={onNavigate}
          className="sr-only"
        >
          {group.items[0].label}
        </Link>
      ) : null}
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1 p-3" aria-label="Admin navigation">
      {ADMIN_NAV.map((group) => (
        <NavGroup key={group.label} group={group} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-card)] lg:block">
      <SidebarContent />
    </aside>
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
        <SidebarContent onNavigate={onClose} />
      </div>
    </div>
  );
}
