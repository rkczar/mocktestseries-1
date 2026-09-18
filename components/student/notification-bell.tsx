"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, ExternalLink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { markAnnouncementReadAction, markAllAnnouncementsReadAction } from "@/app/student/(dashboard)/actions";

export interface BellAnnouncement {
  id: string;
  title: string;
  message: string;
  priority: "NORMAL" | "IMPORTANT";
  ctaLabel: string | null;
  ctaRoute: string | null;
  createdAt: string; // ISO
  isRead: boolean;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NotificationBell({ announcements }: { announcements: BellAnnouncement[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const unreadCount = announcements.filter((a) => !a.isRead).length;

  function handleSelect(a: BellAnnouncement) {
    if (!a.isRead) startTransition(() => markAnnouncementReadAction(a.id));
    if (a.ctaRoute) {
      setOpen(false);
      router.push(a.ctaRoute);
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-primary)]/15 text-[var(--color-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
          aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
        >
          <Bell className="h-4 w-4" aria-hidden />
          {unreadCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-error)] px-1 text-[10px] font-semibold text-white">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex items-center justify-between px-2.5 py-1.5">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unreadCount > 0 ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(() => markAllAnnouncementsReadAction())}
              className="text-xs font-medium text-[var(--color-primary)] hover:underline disabled:opacity-50"
            >
              Mark all read
            </button>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        {announcements.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-sm text-[var(--color-muted-foreground)]">You&apos;re all caught up.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            {announcements.map((a) => (
              <DropdownMenuItem
                key={a.id}
                onSelect={(event) => {
                  event.preventDefault();
                  handleSelect(a);
                }}
                className="flex-col items-start gap-1 whitespace-normal py-2.5"
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <span className={`text-sm ${a.isRead ? "font-medium" : "font-semibold"} text-[var(--color-foreground)]`}>{a.title}</span>
                  {!a.isRead ? <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" aria-hidden /> : null}
                </div>
                <p className="line-clamp-2 text-xs text-[var(--color-muted-foreground)]">{a.message}</p>
                <div className="flex w-full items-center justify-between">
                  <span className="text-[10px] text-[var(--color-muted-foreground)]">{timeAgo(a.createdAt)}</span>
                  {a.priority === "IMPORTANT" ? (
                    <Badge variant="warning" className="text-[9px]">
                      Important
                    </Badge>
                  ) : null}
                  {a.ctaRoute && a.ctaLabel ? (
                    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--color-primary)]">
                      {a.ctaLabel} <ExternalLink className="h-3 w-3" aria-hidden />
                    </span>
                  ) : null}
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
