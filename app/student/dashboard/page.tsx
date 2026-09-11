import type { Metadata } from "next";
import { BarChart3, FileText, Target } from "lucide-react";
import Link from "next/link";

import { Container } from "@/components/common/Container";
import { Logo } from "@/components/layout/Logo";
import { requireStudent } from "@/lib/auth/requireStudent";

import { studentLogoutAction } from "./actions";

export const metadata: Metadata = { title: "Dashboard" };

const SHELL_CARDS = [
  {
    icon: FileText,
    title: "Your attempts",
    body: "Test history and scores will appear here once you attempt a mock test.",
  },
  {
    icon: BarChart3,
    title: "Performance analytics",
    body: "Accuracy, speed and subject splits — unlocked after your first attempt.",
  },
  {
    icon: Target,
    title: "Weak topics",
    body: "We'll surface the topics costing you the most marks as data comes in.",
  },
];

export default async function StudentDashboardPage() {
  const { student } = await requireStudent();

  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="border-b border-border bg-surface">
        <Container className="flex h-[72px] items-center justify-between">
          <Logo />
          <form action={studentLogoutAction}>
            <button
              type="submit"
              className="rounded-[9px] border border-border-strong px-4 py-2.5 text-[14.5px] font-bold text-primary hover:bg-accent"
            >
              Log out
            </button>
          </form>
        </Container>
      </header>

      <main>
        <Container className="py-[clamp(28px,4vw,48px)]">
          <h1 className="font-display text-[clamp(26px,3vw,34px)] font-bold text-text-heading">
            Welcome, {student.name}
          </h1>
          <p className="mt-2 max-w-[60ch] text-[15.5px] leading-relaxed text-text-muted">
            Your dashboard is ready. Take a mock test from the{" "}
            <Link href="/exams" className="font-bold text-primary">
              Exams
            </Link>{" "}
            page to see your results and analysis here.
          </p>

          <div className="mt-8 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-5">
            {SHELL_CARDS.map((card) => (
              <div key={card.title} className="rounded-[14px] border border-border bg-surface p-5.5">
                <span className="flex size-10 items-center justify-center rounded-[11px] border border-primary-border bg-primary-tint">
                  <card.icon className="size-5 text-primary" strokeWidth={1.9} />
                </span>
                <h2 className="mt-4 text-[17px] font-extrabold text-text-heading">{card.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{card.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </main>
    </div>
  );
}
