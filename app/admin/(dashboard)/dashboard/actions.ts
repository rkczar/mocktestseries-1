"use server";

import { adminSignOut } from "@/lib/auth/admin";

export async function adminLogoutAction() {
  await adminSignOut({ redirectTo: "/admin/login" });
}
