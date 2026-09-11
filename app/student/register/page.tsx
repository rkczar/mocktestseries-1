import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/AuthCard";
import { studentAuth } from "@/lib/auth/student";

import { RegisterForm } from "./RegisterForm";

export const metadata: Metadata = { title: "Create Your Account" };

export default async function StudentRegisterPage() {
  const session = await studentAuth();
  if (session) redirect("/student/dashboard");

  return (
    <AuthCard
      title="Create your free account"
      description="Start with a free mock test — no card required."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/student/login" className="font-bold text-primary">
            Log in
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
