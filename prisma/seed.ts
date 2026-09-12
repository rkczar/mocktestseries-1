/**
 * Idempotent database seed.
 *
 * Safe to run any number of times:
 *  - Role and Permission rows are upserted (never duplicated).
 *  - The first MASTER_ADMIN account is created only if no MASTER_ADMIN
 *    AdminUser exists yet. Re-running after that is a no-op for the admin
 *    account, even if ADMIN_SEED_* env vars are still set.
 *
 * Required env vars (only enforced when no MASTER_ADMIN exists yet):
 *   ADMIN_SEED_EMAIL     - login email, also used to derive the username
 *   ADMIN_SEED_PASSWORD  - initial password (min 10 chars, matches the
 *                          same policy enforced by the admin-user creation
 *                          form in app/admin/(dashboard)/users/admins/actions.ts)
 * Optional:
 *   ADMIN_SEED_NAME      - display name (default "Master Admin")
 *   ADMIN_SEED_USERNAME  - login username (default: local part of the email)
 *
 * Run with: npm run db:seed
 */
import "dotenv/config";
import argon2 from "argon2";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleName } from "@prisma/client";
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from "../lib/permissions";
import { ROUTE_MANIFEST } from "../lib/routes";

const MIN_PASSWORD_LENGTH = 10;
const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function seedRolesAndPermissions() {
  const roleByName = new Map<RoleName, { id: string }>();

  for (const name of Object.values(RoleName)) {
    const role = await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    roleByName.set(name, role);
  }

  const permissionByKey = new Map<string, { id: string }>();
  for (const key of Object.values(PERMISSIONS)) {
    const permission = await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
    permissionByKey.set(key, permission);
  }

  for (const [roleName, permissionKeys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = roleByName.get(roleName as RoleName);
    if (!role) continue;
    for (const key of permissionKeys) {
      const permission = permissionByKey.get(key);
      if (!permission) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }

  return roleByName;
}

/**
 * Syncs lib/routes.ts (the single manifest a developer edits when adding a
 * page) into RouteRegistryEntry. Status is only set on first insert — the
 * Website Diagram's own check action (runDiagramCheckAction) recomputes
 * CONNECTED/WARNING/ORPHAN live, and re-seeding must not clobber that.
 */
async function seedRouteRegistry() {
  for (const entry of ROUTE_MANIFEST) {
    await prisma.routeRegistryEntry.upsert({
      where: { route: entry.route },
      update: {
        pageName: entry.pageName,
        module: entry.module,
        userType: entry.userType,
        authRequired: entry.authRequired,
        parentRoute: entry.parentRoute,
      },
      create: {
        pageName: entry.pageName,
        route: entry.route,
        module: entry.module,
        userType: entry.userType,
        authRequired: entry.authRequired,
        parentRoute: entry.parentRoute,
        status: entry.status,
      },
    });
  }
}

function validatePassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_SEED_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters long.`
    );
  }
}

function deriveUsername(email: string): string {
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9._-]/g, "-") ?? "";
  return local || "admin";
}

async function seedMasterAdmin(masterAdminRoleId: string) {
  const existing = await prisma.adminUser.findFirst({
    where: { role: { name: RoleName.MASTER_ADMIN } },
    select: { id: true, username: true },
  });

  if (existing) {
    console.log(`MASTER_ADMIN already exists (username: ${existing.username}) — skipping.`);
    return;
  }

  const email = process.env.ADMIN_SEED_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD;
  const name = process.env.ADMIN_SEED_NAME?.trim() || "Master Admin";
  const username = (process.env.ADMIN_SEED_USERNAME?.trim().toLowerCase() ||
    (email ? deriveUsername(email) : undefined)) as string | undefined;

  if (!email) {
    throw new Error(
      "No MASTER_ADMIN exists yet and ADMIN_SEED_EMAIL is not set. " +
        "Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD and re-run the seed."
    );
  }
  if (!password) {
    throw new Error(
      "No MASTER_ADMIN exists yet and ADMIN_SEED_PASSWORD is not set. " +
        "Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD and re-run the seed."
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("ADMIN_SEED_EMAIL is not a valid email address.");
  }
  if (!username || !USERNAME_PATTERN.test(username)) {
    throw new Error(
      "Could not derive a valid username from ADMIN_SEED_EMAIL. " +
        "Set ADMIN_SEED_USERNAME explicitly (lowercase letters, numbers, dot, underscore, hyphen only)."
    );
  }
  validatePassword(password);

  const passwordHash = await argon2.hash(password);

  const user = await prisma.adminUser.create({
    data: {
      name,
      username,
      email,
      passwordHash,
      roleId: masterAdminRoleId,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      action: "ADMIN_USER_CREATED",
      entityType: "AdminUser",
      entityId: user.id,
      metadata: { username: user.username, source: "seed" },
    },
  });

  console.log(`Created MASTER_ADMIN account (username: ${username}).`);
}

async function main() {
  const roleByName = await seedRolesAndPermissions();
  const masterAdminRole = roleByName.get(RoleName.MASTER_ADMIN);
  if (!masterAdminRole) throw new Error("MASTER_ADMIN role failed to seed.");
  await seedMasterAdmin(masterAdminRole.id);
  await seedRouteRegistry();

  const count = await prisma.adminUser.count({ where: { role: { name: RoleName.MASTER_ADMIN } } });
  console.log(`MASTER_ADMIN accounts in database: ${count}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
