"use server";

import { studentSignOut } from "@/lib/auth/student";

export async function studentLogoutAction() {
  await studentSignOut({ redirectTo: "/" });
}
