import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStudentDeviceSettings } from "@/lib/student-device-settings";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { StudentDeviceSettingsForm } from "./device-settings-form";

export const metadata = { title: "Security — Mock Test Series.in Admin" };

export default async function SecuritySettingsPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="Security Settings" />;
  }
  const settings = await getStudentDeviceSettings();

  return (
    <div className="flex flex-col gap-6">
      <StudentDeviceSettingsForm settings={settings} canEdit />
    </div>
  );
}
