import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Globe,
  GraduationCap,
  HelpCircle,
  ClipboardList,
  Users,
  Sparkles,
  ShieldCheck,
  CreditCard,
  Settings,
} from "lucide-react";

export interface AdminNavItem {
  label: string;
  href: string;
  status: "live" | "draft";
}

export interface AdminNavGroup {
  label: string;
  icon: LucideIcon;
  items: AdminNavItem[];
}

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    label: "Dashboard",
    icon: LayoutDashboard,
    items: [{ label: "Dashboard", href: "/admin", status: "live" }],
  },
  {
    label: "Website",
    icon: Globe,
    items: [
      { label: "Homepage", href: "/admin/website/homepage", status: "live" },
      { label: "Website Diagram", href: "/admin/website/diagram", status: "live" },
      { label: "Appearance", href: "/admin/website/appearance", status: "live" },
      { label: "Navigation", href: "/admin/website/navigation", status: "draft" },
      { label: "Website Content", href: "/admin/website/content", status: "draft" },
      { label: "Footer", href: "/admin/website/footer", status: "draft" },
      { label: "Announcements", href: "/admin/website/announcements", status: "draft" },
    ],
  },
  {
    label: "Exams",
    icon: GraduationCap,
    items: [
      { label: "Manage Exams", href: "/admin/exams", status: "live" },
      { label: "Previous Year Papers", href: "/admin/exams/previous-year-papers", status: "live" },
      { label: "Test Series", href: "/admin/exams/test-series", status: "live" },
      { label: "Subjects", href: "/admin/exams/subjects", status: "draft" },
      { label: "Topics", href: "/admin/exams/topics", status: "draft" },
      { label: "Syllabus", href: "/admin/exams/syllabus", status: "draft" },
    ],
  },
  {
    label: "Questions",
    icon: HelpCircle,
    items: [
      { label: "All Questions", href: "/admin/questions", status: "draft" },
      { label: "Add Questions", href: "/admin/questions/add", status: "draft" },
      { label: "Bulk Import", href: "/admin/questions/bulk-import", status: "draft" },
      { label: "Question Templates", href: "/admin/questions/templates", status: "draft" },
      { label: "Question Reports", href: "/admin/questions/reports", status: "draft" },
      { label: "Question Queries", href: "/admin/questions/queries", status: "draft" },
    ],
  },
  {
    label: "Tests",
    icon: ClipboardList,
    items: [
      { label: "Test Builder", href: "/admin/tests/builder", status: "draft" },
      { label: "Mock Tests", href: "/admin/tests/mock", status: "draft" },
      { label: "Random Tests", href: "/admin/tests/random", status: "draft" },
      { label: "Custom Tests", href: "/admin/tests/custom", status: "draft" },
      { label: "Live Tests", href: "/admin/tests/live", status: "draft" },
      { label: "Scheduled Tests", href: "/admin/tests/scheduled", status: "draft" },
    ],
  },
  {
    label: "Students",
    icon: Users,
    items: [
      { label: "All Students", href: "/admin/students", status: "draft" },
      { label: "Test History", href: "/admin/students/history", status: "draft" },
      { label: "Attempted Questions", href: "/admin/students/attempted", status: "draft" },
      { label: "Deletion Requests", href: "/admin/students/deletion-requests", status: "draft" },
    ],
  },
  {
    label: "AI",
    icon: Sparkles,
    items: [
      { label: "AI Solution Manager", href: "/admin/ai/solution-manager", status: "draft" },
      { label: "AI Solutions", href: "/admin/ai/solutions", status: "draft" },
      { label: "AI Question Variants", href: "/admin/ai/variants", status: "draft" },
      { label: "AI Usage", href: "/admin/ai/usage", status: "draft" },
      { label: "AI Settings", href: "/admin/ai/settings", status: "draft" },
    ],
  },
  {
    label: "Users & Access",
    icon: ShieldCheck,
    items: [
      { label: "Admin Users", href: "/admin/users/admins", status: "live" },
      { label: "Roles", href: "/admin/users/roles", status: "live" },
      { label: "Teachers", href: "/admin/users/teachers", status: "draft" },
      { label: "Permissions", href: "/admin/users/permissions", status: "draft" },
    ],
  },
  {
    label: "Payments",
    icon: CreditCard,
    items: [
      { label: "Transactions", href: "/admin/payments/transactions", status: "draft" },
      { label: "Orders", href: "/admin/payments/orders", status: "draft" },
      { label: "Revenue", href: "/admin/payments/revenue", status: "draft" },
    ],
  },
  {
    label: "Settings",
    icon: Settings,
    items: [
      { label: "General Settings", href: "/admin/settings/general", status: "draft" },
      { label: "Security", href: "/admin/settings/security", status: "draft" },
      { label: "Authentication", href: "/admin/settings/authentication", status: "draft" },
      { label: "Notifications", href: "/admin/settings/notifications", status: "draft" },
    ],
  },
];
