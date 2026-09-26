import { AvailableElsewhere } from "@/components/admin/available-elsewhere";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  DEFAULT_WHATSAPP_SUPPORT_LABEL,
  DEFAULT_WHATSAPP_SUPPORT_MESSAGE,
  WHATSAPP_SUPPORT_LABEL_MAX,
  WHATSAPP_SUPPORT_MESSAGE_MAX,
  getWhatsAppSupportConfig,
} from "@/lib/whatsapp-support";
import { WhatsAppSupportForm } from "./whatsapp-support-form";

export const metadata = { title: "Footer — Mock Test Series.in Admin" };

export default async function Page() {
  const [session, config] = await Promise.all([getAdminSession(), getWhatsAppSupportConfig()]);
  const canManage = session?.user?.permissions?.includes(PERMISSIONS.WEBSITE_MANAGE) ?? false;

  return (
    <div className="flex flex-col gap-6">
      <AvailableElsewhere
        title="Footer"
        message="Footer content (contact email, location, Instagram, footer links, copyright) is edited on the Footer section of the Homepage Builder, not here."
        linkHref="/admin/website?tab=homepage"
        linkLabel="Go to Homepage → Footer"
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <WhatsAppSupportForm
          config={config}
          canManage={canManage}
          defaults={{
            message: DEFAULT_WHATSAPP_SUPPORT_MESSAGE,
            label: DEFAULT_WHATSAPP_SUPPORT_LABEL,
            messageMax: WHATSAPP_SUPPORT_MESSAGE_MAX,
            labelMax: WHATSAPP_SUPPORT_LABEL_MAX,
          }}
        />
      </div>
    </div>
  );
}
