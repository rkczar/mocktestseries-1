import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStudentDashboardLayout } from "@/lib/student-dashboard-layout";
import { StudentDashboardManager } from "./dashboard-manager";

/** Admin → Website → Student Dashboard tab. Not a route: rendered inside the Website control center. */
export async function StudentDashboardPanel() {
  const [session, layout] = await Promise.all([getAdminSession(), getStudentDashboardLayout()]);
  const canManage = session?.user?.permissions?.includes(PERMISSIONS.WEBSITE_MANAGE) ?? false;
  return <StudentDashboardManager initialLayout={layout} canManage={canManage} />;
}
