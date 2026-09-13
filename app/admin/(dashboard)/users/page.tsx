import { ControlCenterTabs } from "@/components/admin/control-center-tabs";
import AdminUsersPage from "./admins/page";
import TeachersPage from "./teachers/page";
import RolesPage from "./roles/page";
import PermissionsPage from "./permissions/page";

export const metadata = { title: "Users & Access — Mock Test Series.in Admin" };

export default function UsersControlCenter() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Users & Access</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Admin users, teachers, roles, and permissions.</p>
      </div>

      <ControlCenterTabs
        defaultValue="admins"
        tabs={[
          { value: "admins", label: "Admins", content: <AdminUsersPage /> },
          { value: "teachers", label: "Teachers", content: <TeachersPage /> },
          { value: "roles", label: "Roles", content: <RolesPage /> },
          { value: "permissions", label: "Permissions", content: <PermissionsPage /> },
        ]}
      />
    </div>
  );
}
