import type { CSSProperties } from "react";
import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/student-session";
import { getLoginPageConfig } from "@/lib/login-page";
import { getAuthProviderConfig } from "@/lib/auth-provider-config";
import { LeftCanvas } from "./left-canvas";
import { LoginScreen } from "./login-screen";

export const metadata = { title: "Student Login — Mock Test Series.in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; tab?: string }>;
}) {
  const session = await getStudentSession();
  if (session?.user) redirect("/student/dashboard");

  const { callbackUrl, tab } = await searchParams;
  const [pageConfig, providerConfig] = await Promise.all([getLoginPageConfig(), getAuthProviderConfig()]);

  const showLeft = pageConfig.splitLayout && pageConfig.leftPanelEnabled;

  // This page always renders the dark login aesthetic from Admin -> Website
  // -> Login Page, independent of the viewer's site-wide Day/Night/Eye-Saver
  // toggle: overriding the shared design-token custom properties here (not
  // just the two background colors) keeps every reused UI primitive
  // (Input, Label, Button) legible even when the rest of the site is in
  // Light mode.
  const tokenOverrides = {
    background: pageConfig.background.canvas,
    ["--right-panel-w"]: `${pageConfig.rightPanelWidth}px`,
    ["--color-foreground"]: "#ffffff",
    ["--color-muted-foreground"]: "rgba(255,255,255,0.55)",
    ["--color-border"]: pageConfig.background.border,
    ["--color-surface"]: "rgba(255,255,255,0.04)",
    ["--color-card"]: pageConfig.background.panel,
    ["--color-primary"]: "#6366f1",
    ["--color-action-fill"]: "#6366f1",
    ["--color-action-ink"]: "#ffffff",
    colorScheme: "dark",
  } as CSSProperties;

  return (
    <div className="relative flex min-h-screen flex-col sm:flex-row" style={tokenOverrides}>
      {showLeft ? <LeftCanvas config={pageConfig} /> : null}

      <div
        className="relative flex w-full flex-1 items-center justify-center px-4 py-12 sm:w-[var(--right-panel-w)] sm:flex-none"
        style={{ background: pageConfig.background.panel }}
      >
        {pageConfig.background.ambient ? (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: "radial-gradient(60% 50% at 70% 10%, rgba(99,102,241,0.15), transparent 60%)",
            }}
          />
        ) : null}

        <LoginScreen
          callbackUrl={callbackUrl ?? "/student/dashboard"}
          defaultMode={tab === "register" ? "register" : "signin"}
          defaultMethod={tab === "otp" ? "otp" : "password"}
          pageConfig={pageConfig}
          providerConfig={providerConfig}
        />
      </div>
    </div>
  );
}
