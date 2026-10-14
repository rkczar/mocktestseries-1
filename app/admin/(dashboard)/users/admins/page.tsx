import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AdminUserForm } from "./admin-user-form";
import { UserToggle } from "./user-toggle";
import { AdminUserEdit, type EditableAdmin } from "./admin-user-edit";
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

const ACTIVITY_LABEL: Record<string, string> = {
  ADMIN_LOGIN: "Signed in",
  ADMIN_USER_CREATED: "Created an admin user",
  ADMIN_USER_UPDATED: "Admin profile updated",
  ADMIN_ROLE_CHANGED: "Role changed",
  ADMIN_PASSWORD_RESET: "Password reset",
  ADMIN_USER_ACTIVATED: "Account enabled",
  ADMIN_USER_DEACTIVATED: "Account disabled",
  ADMIN_REAUTH_FAILED: "Failed password re-check",
};

/** Masks an IP for display (keeps the network part only). */
function maskIp(ip: string) {
  if (ip.includes(".")) return ip.split(".").slice(0, 2).join(".") + ".x.x";
  return ip.split(":").slice(0, 3).join(":") + ":…";
}

export const metadata = { title: "Admin Users — Mock Test Series.in Admin" };

export default async function AdminUsersPage() {
  const [session, users, roles] = await Promise.all([
    getAdminSession(),
    prisma.adminUser.findMany({ include: { role: true }, orderBy: { createdAt: "asc" } }),
    prisma.role.findMany({ orderBy: { name: "asc" } }),
  ]);
  const canManage = Boolean(session?.user?.permissions?.includes(PERMISSIONS.USERS_MANAGE));

  // Account activity for the Edit dialog: this admin's own actions and actions taken on their account, plus sign-in attempts.
  const editable = new Map<string, EditableAdmin>();
  if (canManage) {
    const ids = users.map((u) => u.id);
    const [logs, attempts] = await Promise.all([
      prisma.auditLog.findMany({
        where: { OR: [{ actorId: { in: ids } }, { entityType: "AdminUser", entityId: { in: ids } }] },
        orderBy: { createdAt: "desc" },
        take: 400,
        select: { actorId: true, entityId: true, entityType: true, action: true, createdAt: true, actor: { select: { name: true } } },
      }),
      prisma.loginAttempt.findMany({ where: { adminUserId: { in: ids } }, orderBy: { createdAt: "desc" }, take: 200, select: { adminUserId: true, success: true, ipAddress: true, createdAt: true } }),
    ]);
    for (const u of users) {
      const own = logs
        .filter((l) => l.actorId === u.id || (l.entityType === "AdminUser" && l.entityId === u.id))
        .filter((l) => l.action !== "ADMIN_LOGIN")
        .slice(0, 8)
        .map((l) => ({
          at: l.createdAt.toISOString(),
          text:
            l.entityType === "AdminUser" && l.entityId === u.id && l.actorId !== u.id
              ? `${ACTIVITY_LABEL[l.action] ?? l.action.toLowerCase().replace(/_/g, " ")} by ${l.actor?.name ?? "an admin"}`
              : (ACTIVITY_LABEL[l.action] ?? l.action.toLowerCase().replace(/_/g, " ")),
        }));
      const signIns = attempts
        .filter((a) => a.adminUserId === u.id)
        .slice(0, 5)
        .map((a) => ({ at: a.createdAt.toISOString(), text: `${a.success ? "Sign-in" : "Failed sign-in"} from ${maskIp(a.ipAddress)}` }));
      editable.set(u.id, {
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        roleId: u.roleId,
        roleName: u.role.name,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
        activity: [...own, ...signIns].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12),
      });
    }
  }
  const rolePermissions = Object.fromEntries(Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([k, v]) => [k, [...v]]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Admin Users</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Master Admin, Admin, and Teacher roles (Section 52). Granular per-permission editing arrives in Phase 11 —
          for now each role has a fixed default permission set.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>New Admin User</CardTitle></CardHeader>
        <CardContent>
          <AdminUserForm roles={roles} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Admin Users</CardTitle>
          <CardDescription>{users.length} user{users.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Username</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Last Login</th>
                <th className="py-2 pr-4">Active</th>
                {canManage ? <th className="py-2 pr-4">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{user.name}</td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{user.username}</td>
                  <td className="py-2.5 pr-4"><Badge variant="primary">{user.role.name.replace("_", " ")}</Badge></td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                    {user.lastLoginAt?.toLocaleString("en-IN") ?? "Never"}
                  </td>
                  <td className="py-2.5 pr-4">
                    <UserToggle userId={user.id} isActive={user.isActive} isSelf={user.id === session?.user.id} />
                  </td>
                  {canManage && editable.has(user.id) ? (
                    <td className="py-2.5 pr-4">
                      <AdminUserEdit admin={editable.get(user.id)!} roles={roles.map((r) => ({ id: r.id, name: r.name }))} rolePermissions={rolePermissions} isSelf={user.id === session?.user.id} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
