"use client";

import { RouteError } from "@/components/errors/route-error";

export default function StudentError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} home={{ href: "/student/dashboard", label: "Back to dashboard" }} />;
}
