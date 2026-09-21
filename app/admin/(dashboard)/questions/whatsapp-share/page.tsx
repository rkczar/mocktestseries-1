import { getWhatsAppShareConfig } from "@/lib/whatsapp-share-config";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { WhatsAppShareForm } from "./whatsapp-share-form";

export const metadata = { title: "WhatsApp Share — Mock Test Series.in Admin" };

export default async function WhatsAppSharePage() {
  const [session, config] = await Promise.all([getAdminSession(), getWhatsAppShareConfig()]);
  const canManage = session?.user?.permissions?.includes(PERMISSIONS.QUESTIONS_MANAGE) ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">WhatsApp Share</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Controls the WhatsApp Share action on the Student Review Answers page (Section 16).
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <WhatsAppShareForm config={config} canManage={canManage} />
      </div>
    </div>
  );
}
