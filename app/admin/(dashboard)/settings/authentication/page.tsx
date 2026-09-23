import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getAuthProviderConfig } from "@/lib/auth-provider-config";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { RestrictedCard } from "@/components/admin/restricted-card";
import { Card, CardContent } from "@/components/ui/card";
import { GoogleOAuthCard, Msg91Card, LoginMethodsCard } from "./auth-settings-form";
import { ApiLogsCard, SecurityAuditCard } from "./audit-panels";

export const metadata = { title: "API Management — Mock Test Series.in Admin" };

const AUDIT_ENTITY_IDS = ["auth.providers", "api.gemini", "api.razorpay"];

export default async function ApiManagementPage() {
  const session = await getAdminSession();
  if (!session?.user?.permissions?.includes(PERMISSIONS.SETTINGS_MANAGE)) {
    return <RestrictedCard title="API Management" />;
  }

  const [config, logs] = await Promise.all([
    getAuthProviderConfig(),
    prisma.auditLog.findMany({
      where: { entityId: { in: AUDIT_ENTITY_IDS } },
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">API Management</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Configure Google Sign-In and Phone OTP/SMS from one place. Secrets are encrypted at rest and
          never shown again after saving — only a configured/connected status is displayed here.
        </p>
      </div>

      <Card>
        <CardContent className="py-4 text-sm text-[var(--color-muted-foreground)]">
          Gemini AI settings (used by Ask AI and AI-generated question variants) moved to{" "}
          <Link href="/admin/ai/settings" className="text-[var(--color-primary)] hover:underline">
            AI → Settings
          </Link>
          . Razorpay credentials moved to{" "}
          <Link href="/admin/payments?tab=gateway" className="text-[var(--color-primary)] hover:underline">
            Payments → Gateway Settings
          </Link>
          .
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GoogleOAuthCard google={config.google} />
        <Msg91Card msg91={config.msg91} />
      </div>

      <LoginMethodsCard config={config} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ApiLogsCard logs={logs} />
        <SecurityAuditCard logs={logs} />
      </div>
    </div>
  );
}
