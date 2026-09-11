"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export function NavLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "rounded-lg px-3 py-2.5 text-[14.5px] whitespace-nowrap transition-colors duration-150 hover:bg-accent hover:text-primary",
        isActive ? "bg-primary-tint font-bold text-primary" : "font-medium text-text-muted",
        className,
      )}
    >
      {children}
    </Link>
  );
}
