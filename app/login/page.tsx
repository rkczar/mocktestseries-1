import { redirect } from "next/navigation";
import { getStudentSession } from "@/lib/student-session";
import { ThemeToggle } from "@/components/theme/theme-toggle";
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
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4 py-12">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <LoginScreen
        callbackUrl={callbackUrl ?? "/student/dashboard"}
        googleEnabled={googleEnabled}
        defaultTab={tab === "register" ? "register" : tab === "otp" ? "otp" : "login"}
      />
    </div>
  );
}
