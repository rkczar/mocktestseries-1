"use client";

import {
  Bell,
  ClipboardCheck,
  Database,
  DollarSign,
  FileQuestion,
  Home,
  LayoutDashboard,
  Palette,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const NAV = [
  { href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard, minRole: "ADMIN" as const },
  { href: "/admin/homepage", label: "Homepage", icon: Home, minRole: "ADMIN" as const },
  { href: "/admin/announcements", label: "Announcements", icon: Bell, minRole: "ADMIN" as const },
  { href: "/admin/exams", label: "Exams", icon: ClipboardCheck, minRole: "ADMIN" as const },
  { href: "/admin/test-series", label: "Test Series", icon: ClipboardCheck, minRole: "ADMIN" as const },
  { href: "/admin/upcoming-exams", label: "Upcoming Exams", icon: Bell, minRole: "ADMIN" as const },
  { href: "/admin/pricing", label: "Pricing", icon: DollarSign, minRole: "ADMIN" as const },
  { href: "/admin/questions", label: "Question Bank", icon: FileQuestion, minRole: "ADMIN" as const },
  { href: "/admin/students", label: "Students", icon: Users, minRole: "ADMIN" as const },
  { href: "/admin/admins", label: "Admins & Roles", icon: ShieldCheck, minRole: "SUPER_ADMIN" as const },
  { href: "/admin/appearance", label: "Appearance", icon: Palette, minRole: "ADMIN" as const },
  { href: "/admin/cache", label: "Cache Management", icon: Database, minRole: "ADMIN" as const },
];

export function AdminSidebar({ role }: { role: "ADMIN" | "SUPER_ADMIN" }) {
  const pathname = usePathname();

  return (
    <nav className="flex w-full flex-col gap-0.5 p-3 lg:w-60 lg:flex-none lg:border-r lg:border-border lg:p-4">
      {NAV.filter((item) => item.minRole === "ADMIN" || role === "SUPER_ADMIN").map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[14px] font-semibold transition-colors duration-150",
              isActive
                ? "bg-primary-tint text-primary"
                : "text-text-muted hover:bg-accent hover:text-primary",
            )}
          >
            <item.icon className="size-[17px] flex-none" strokeWidth={1.9} />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
