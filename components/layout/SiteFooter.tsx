import Link from "next/link";

import { Logo } from "./Logo";

const FOOTER_COLUMNS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: "Practice",
    links: [
      { label: "Exams", href: "/exams" },
      { label: "Test Series", href: "/test-series" },
      { label: "Upcoming Exams", href: "/upcoming-exams" },
      { label: "Pricing", href: "/pricing" },
    ],
  },
  {
    heading: "Students",
    links: [
      { label: "Login", href: "/student/login" },
      { label: "Register", href: "/student/register" },
      { label: "Dashboard", href: "/student/dashboard" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-surface pt-14 pb-7">
      <div className="mx-auto max-w-[1200px] px-6">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-8">
          <div className="min-w-0">
            <Logo size="sm" />
            <p className="mt-3 max-w-[34ch] text-sm leading-relaxed text-text-faint">
              AI-powered mock test series for competitive and recruitment exams in India.
            </p>
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading} className="min-w-0">
              <p className="font-mono text-[11px] font-semibold tracking-[.1em] text-text-placeholder uppercase">
                {column.heading}
              </p>
              <ul className="mt-3.5 flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-[14.5px] text-text-muted transition-colors duration-150 hover:text-primary"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-9 flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5 border-t border-border-subtle pt-5">
          <p className="text-[13px] text-text-placeholder">
            © {year} MockTestSeries.in. All rights reserved.
          </p>
          <p className="font-mono text-xs tracking-[.03em] text-text-placeholder">
            Made for serious aspirants
          </p>
        </div>
      </div>
    </footer>
  );
}
