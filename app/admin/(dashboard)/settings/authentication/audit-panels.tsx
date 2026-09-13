import { CheckCircle2, XCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import type { AuditLog, AdminUser } from "@prisma/client";

type AuditLogWithActor = AuditLog & { actor: Pick<AdminUser, "name"> | null };

const PROVIDER_LABEL: Record<string, string> = {
  GOOGLE: "Google Sign-In",
  MSG91: "Phone OTP / SMS",
  GEMINI: "Gemini AI",
  RAZORPAY: "Razorpay Payment Gateway",
};

function providerFromAction(action: string): string {
  for (const key of Object.keys(PROVIDER_LABEL)) {
    if (action.includes(key)) return PROVIDER_LABEL[key];
  }
  if (action === "AUTH_LOGIN_METHODS_SAVED") return "Login Methods";
  return action;
}

function isTestAction(action: string): boolean {
  return action.endsWith("_TESTED");
}

function describeSecurityAction(log: AuditLogWithActor): string {
  const provider = providerFromAction(log.action);
  const metadata = (log.metadata as { enabled?: boolean } | null) ?? null;
  if (log.action === "AUTH_LOGIN_METHODS_SAVED") return "Updated login methods";
  if (metadata?.enabled === false) return `Disabled ${provider}`;
  if (metadata?.enabled === true) return `Enabled ${provider}`;
  return `Updated ${provider} configuration`;
}

export function ApiLogsCard({ logs }: { logs: AuditLogWithActor[] }) {
  const testLogs = logs.filter((l) => isTestAction(l.action)).slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Logs</CardTitle>
        <CardDescription>Never includes secret values, OTPs or API keys.</CardDescription>
      </CardHeader>
      <CardContent>
        {testLogs.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">No test connections have been run yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--color-border)]">
            {testLogs.map((log) => {
              const ok = (log.metadata as { ok?: boolean } | null)?.ok ?? false;
              return (
                <div key={log.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-[var(--color-foreground)]">{providerFromAction(log.action)} — Test Connection</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`flex items-center gap-1 text-xs font-medium ${ok ? "text-[var(--color-success)]" : "text-[var(--color-error)]"}`}
                    >
                      {ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />}
                      {ok ? "Success" : "Failed"}
                    </span>
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      {log.createdAt.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SecurityAuditCard({ logs }: { logs: AuditLogWithActor[] }) {
  const auditLogs = logs.filter((l) => !isTestAction(l.action)).slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security Audit</CardTitle>
        <CardDescription>Every configuration change, without secret values.</CardDescription>
      </CardHeader>
      <CardContent>
        {auditLogs.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-foreground)]">No configuration changes yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--color-border)]">
            {auditLogs.map((log) => (
              <div key={log.id} className="py-2 text-sm">
                <p className="text-[var(--color-foreground)]">
                  <span className="font-medium">{log.actor?.name ?? "Unknown admin"}</span> {describeSecurityAction(log)}
                </p>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {log.createdAt.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
