import type { Metadata } from "next";

import { AdminCacheManagementPanel } from "@/components/cache/AdminCacheManagementPanel";

export const metadata: Metadata = { title: "Cache Management · Admin" };

export default function CacheManagementPage() {
  return (
    <div>
      <h1 className="font-display text-[26px] font-bold text-text-heading">Cache Management</h1>
      <p className="mt-1.5 max-w-lg text-sm text-text-muted">
        The single place to invalidate application and browser-side caches. These same three
        operations also power the compact development control in the public Footer.
      </p>
      <div className="mt-6">
        <AdminCacheManagementPanel />
      </div>
    </div>
  );
}
