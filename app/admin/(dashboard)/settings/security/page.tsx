import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { getStudentDeviceSettings } from "@/lib/student-device-settings";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { StudentDeviceSettingsForm } from "./device-settings-form";
import { getAdminOtpMethods } from "@/lib/admin-otp-settings";
import { AdminOtpLoginForm } from "./admin-otp-form";

export const metadata = { title: "Security — Mock Test Series.in Admin" };

export default async function SecuritySettingsPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="Security Settings" />;
  }
  const settings = await getStudentDeviceSettings();
  const adminOtp = await getAdminOtpMethods();

  return (
    <div className="flex flex-col gap-6">
      <StudentDeviceSettingsForm settings={settings} canEdit />
      <AdminOtpLoginForm enabled={adminOtp.email} mobileEnabled={adminOtp.mobile} canEdit={session.user.role === "MASTER_ADMIN"} />
    </div>
  );
}
