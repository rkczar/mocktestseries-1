import { Logo } from "@/components/layout/Logo";

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="flex min-h-full items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-[420px]">
        <div className="mb-7 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-border bg-surface p-7 shadow-[0_10px_30px_-20px_rgba(15,76,129,.4)]">
          <h1 className="font-display text-2xl font-bold text-text-heading">{title}</h1>
          <p className="mt-1.5 text-sm text-text-muted">{description}</p>
          <div className="mt-6">{children}</div>
        </div>
        {footer ? <p className="mt-5 text-center text-sm text-text-muted">{footer}</p> : null}
      </div>
    </main>
  );
}
