"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const VIDEO_STUDIO_SECTIONS = [
  { label: "Dashboard", href: "/admin/video-studio" },
  { label: "Create Video", href: "/admin/video-studio/new" },
  { label: "AI Video Editor", href: "/admin/video-studio/editor" },
  { label: "Motion Workflow Studio", href: "/admin/video-studio/motion" },
  { label: "Skill Library", href: "/admin/video-studio/skills" },
  { label: "Design Gallery", href: "/admin/video-studio/designs" },
  { label: "Voice Studio", href: "/admin/video-studio/voices" },
  { label: "Video History", href: "/admin/video-studio/history" },
  { label: "Cost Center", href: "/admin/video-studio/costs" },
  { label: "Settings & Branding", href: "/admin/video-studio/settings" },
] as const;

/** Section switcher for Admin → AI Video Studio (the sidebar keeps one entry). */
export function VideoStudioSubnav() {
  const pathname = usePathname();
  return (
    <nav aria-label="AI Video Studio sections" className="flex flex-wrap gap-2">
      {VIDEO_STUDIO_SECTIONS.map((item) => {
        const active = item.href === "/admin/video-studio" ? pathname === item.href || pathname.startsWith("/admin/video-studio/jobs/") : pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-[var(--radius-button)] border px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
