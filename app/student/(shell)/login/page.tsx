import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/AuthCard";
import { studentAuth } from "@/lib/auth/student";

import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Student Login" };

export default async function StudentLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await studentAuth();
  if (session) redirect("/student/dashboard");

  const { next } = await searchParams;

  return (
    <AuthCard
      title="Log in to your account"
      description="Pick up where you left off."
      footer={
        <>
          New here?{" "}
          <Link href="/student/register" className="font-bold text-primary">
            Create a free account
          </Link>
        </>
      }
    >
      <LoginForm next={next ?? "/student/dashboard"} />
    </AuthCard>
  );
}
