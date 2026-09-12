import type { PermissionKey } from "@/lib/permissions";

declare module "next-auth" {
  interface User {
    role?: string;
  }
  interface Session {
    user: {
      id?: string;
      name?: string | null;
      email?: string | null;
      role?: string;
      permissions?: PermissionKey[];
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
    permissions?: PermissionKey[];
  }
}
