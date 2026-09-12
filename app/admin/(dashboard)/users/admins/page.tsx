import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AdminUserForm } from "./admin-user-form";
import { UserToggle } from "./user-toggle";

export const metadata = { title: "Admin Users — Mock Test Series.in Admin" };

export default async function AdminUsersPage() {
  const [session, users, roles] = await Promise.all([
    getAdminSession(),
    prisma.adminUser.findMany({ include: { role: true }, orderBy: { createdAt: "asc" } }),
    prisma.role.findMany({ orderBy: { name: "asc" } }),
  ]);

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
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Username</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Last Login</th>
                <th className="py-2 pr-4">Active</th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
