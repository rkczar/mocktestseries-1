import { AtSign, Mail, MapPin } from "lucide-react";
import Link from "next/link";

import { Logo } from "./Logo";

const SUPPORT_EMAIL = "info@mocktestseries.com";
const INSTAGRAM_HANDLE = "Mock Test Series.in";
const INSTAGRAM_HREF = "https://instagram.com/mocktestseries.in";

const LEGAL_LINKS = [
  { label: "Contact Us", href: "/contact" },
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Terms and Conditions", href: "/terms" },
];

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-surface pt-12 pb-7">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-6">
        <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-7">
          <div className="min-w-0 max-w-[36ch]">
            <Logo size="sm" />
            <p className="mt-3 text-sm leading-relaxed text-text-faint">
              AI-powered mock test series for competitive and recruitment exams in India.
            </p>
          </div>

          <div className="flex flex-col gap-2.5 text-[14.5px] text-text-muted">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="flex items-center gap-2 transition-colors duration-150 hover:text-primary"
            >
              <Mail className="size-4 flex-none text-text-faint" strokeWidth={2} />
              {SUPPORT_EMAIL}
            </a>
            <a
              href={INSTAGRAM_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 transition-colors duration-150 hover:text-primary"
            >
              <AtSign className="size-4 flex-none text-text-faint" strokeWidth={2} />
              {INSTAGRAM_HANDLE}
            </a>
            <span className="flex items-center gap-2">
              <MapPin className="size-4 flex-none text-text-faint" strokeWidth={2} />
              Jaipur, India
            </span>
          </div>

          <nav className="flex flex-col gap-2.5 text-[14.5px]">
            {LEGAL_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-text-muted transition-colors duration-150 hover:text-primary"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2.5 border-t border-border-subtle pt-5">
          <p className="text-[13px] text-text-placeholder">
            © {year} MockTestSeries.in. All rights reserved.
          </p>
          <p className="font-mono text-xs tracking-[.03em] text-text-placeholder">
            Made with love in India
          </p>
        </div>
      </div>
    </footer>
  );
}
