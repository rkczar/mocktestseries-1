import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/AuthCard";
import { adminAuth } from "@/lib/auth/admin";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Admin Login", robots: { index: false, follow: false } };

export default async function AdminLoginPage() {
  const session = await adminAuth();
  if (session) redirect("/admin/dashboard");

  return (
    <main>
      <AuthCard title="Admin sign in" description="Restricted access. Admin accounts only.">
        <LoginForm />
      </AuthCard>
    </main>
  );
}
