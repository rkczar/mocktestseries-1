import { getLoginPageConfig } from "@/lib/login-page";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LoginPageForm } from "./login-page-form";

export const metadata = { title: "Login Page Design — Mock Test Series.in Admin" };

export default async function LoginPageDesignPage() {
  const config = await getLoginPageConfig();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Login Page Design</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Controls the split layout, dark canvas, and left-side vacant space on the public student login page
          (/login). The left canvas stays blank until content is added below — nothing promotional is ever forced
          in by default. Provider visibility (Google / OTP / Password / Create Account) is managed from
          Settings → Authentication.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Design Settings</CardTitle>
          <CardDescription>Changes apply to /login immediately after saving.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginPageForm config={config} />
        </CardContent>
      </Card>
    </div>
  );
}
