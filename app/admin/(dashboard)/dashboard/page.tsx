import type { Metadata } from "next";
import {
  Bell,
  ClipboardCheck,
  DollarSign,
  FileQuestion,
  Home,
  Palette,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";

import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Admin Dashboard", robots: { index: false, follow: false } };

const AREAS = [
  { href: "/admin/homepage", label: "Homepage", icon: Home },
  { href: "/admin/announcements", label: "Announcements", icon: Bell },
  { href: "/admin/exams", label: "Exams", icon: ClipboardCheck },
  { href: "/admin/test-series", label: "Test Series", icon: ClipboardCheck },
  { href: "/admin/upcoming-exams", label: "Upcoming Exams", icon: Bell },
  { href: "/admin/pricing", label: "Pricing", icon: DollarSign },
  { href: "/admin/questions", label: "Question Bank", icon: FileQuestion },
  { href: "/admin/students", label: "Students", icon: Users },
  { href: "/admin/admins", label: "Admins & Roles", icon: ShieldCheck },
  { href: "/admin/appearance", label: "Appearance", icon: Palette },
];

export default async function AdminDashboardPage() {
  const [examCount, questionCount, studentCount, seriesCount] = await Promise.all([
    prisma.exam.count(),
    prisma.question.count(),
    prisma.student.count(),
    prisma.testSeries.count(),
  ]);

  const stats = [
    { label: "Exams", value: examCount },
    { label: "Questions", value: questionCount },
    { label: "Students", value: studentCount },
    { label: "Test series", value: seriesCount },
  ];

  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Overview</h1>
      <p className="mt-1.5 text-sm text-text-muted">Live counts from the database.</p>

      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-[12px] border border-border bg-surface p-4">
            <p className="font-display text-2xl font-bold text-text-heading">{stat.value}</p>
            <p className="mt-1 text-[13px] text-text-faint">{stat.label}</p>
          </div>
        ))}
      </div>

      <h2 className="mt-9 text-lg font-extrabold text-text-heading">Content areas</h2>
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {AREAS.map((area) => (
          <Link
            key={area.href}
            href={area.href}
            className="flex items-center gap-3 rounded-[12px] border border-border bg-surface p-4 text-sm font-bold text-text-heading transition-colors duration-150 hover:border-primary"
          >
            <area.icon className="size-[18px] text-primary" strokeWidth={1.9} />
            {area.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
