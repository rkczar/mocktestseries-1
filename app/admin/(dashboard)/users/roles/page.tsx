import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DEFAULT_ROLE_PERMISSIONS } from "@/lib/permissions";
import type { RoleName } from "@prisma/client";

export const metadata = { title: "Roles — Mock Test Series.in Admin" };

export default async function RolesPage() {
  const roles = await prisma.role.findMany({
    include: { _count: { select: { adminUsers: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Roles</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Fixed default permission sets for this phase. A custom-permission editor arrives in Phase 11.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {roles.map((role) => (
          <Card key={role.id}>
            <CardHeader>
              <CardTitle>{role.name.replace("_", " ")}</CardTitle>
              <CardDescription>{role._count.adminUsers} admin{role._count.adminUsers === 1 ? "" : "s"}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {DEFAULT_ROLE_PERMISSIONS[role.name as RoleName].map((perm) => (
                <Badge key={perm} variant="neutral">{perm}</Badge>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
