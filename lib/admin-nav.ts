import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Globe,
  GraduationCap,
  HelpCircle,
  ClipboardList,
  Users,
  Sparkles,
  CreditCard,
  ShieldCheck,
  BarChart3,
  MessageSquare,
  Search,
  Lock,
  Archive,
  HardDrive,
  Settings,
} from "lucide-react";

export interface AdminNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { label: "Website", href: "/admin/website", icon: Globe },
  { label: "Exams", href: "/admin/exams", icon: GraduationCap },
  { label: "Question Bank", href: "/admin/questions", icon: HelpCircle },
  { label: "Tests", href: "/admin/tests", icon: ClipboardList },
  { label: "Students", href: "/admin/students", icon: Users },
  { label: "AI Solutions", href: "/admin/ai", icon: Sparkles },
  { label: "Payments", href: "/admin/payments", icon: CreditCard },
  { label: "Users & Access", href: "/admin/users", icon: ShieldCheck },
  { label: "Analytics", href: "/admin/analytics", icon: BarChart3 },
  { label: "Communications", href: "/admin/communications", icon: MessageSquare },
  { label: "SEO", href: "/admin/seo", icon: Search },
  { label: "Security", href: "/admin/security", icon: Lock },
  { label: "Backup", href: "/admin/backup", icon: Archive },
  { label: "System", href: "/admin/system", icon: HardDrive },
  { label: "Settings", href: "/admin/settings", icon: Settings },
];

/** Dashboard's href ("/admin") is a prefix of every other route, so it needs an exact match. */
export function isNavItemActive(pathname: string, href: string) {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(href + "/");
}
