"use client";

import { RouteError } from "@/components/errors/route-error";

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <RouteError error={error} retry={retry} home={{ href: "/", label: "Go to homepage" }} />;
}
