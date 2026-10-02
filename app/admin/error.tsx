"use client";

import { RouteError } from "@/components/errors/route-error";

export default function AdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} home={{ href: "/admin", label: "Back to admin dashboard" }} />;
}
