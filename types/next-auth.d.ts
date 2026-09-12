import type { PermissionKey } from "@/lib/permissions";

declare module "next-auth" {
  interface User {
    role?: string;
    studentId?: string;
    authProvider?: string;
  }
  interface Session {
    user: {
      id?: string;
      name?: string | null;
      email?: string | null;
      role?: string;
      permissions?: PermissionKey[];
      studentId?: string;
      mobile?: string | null;
      authProvider?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: string;
    permissions?: PermissionKey[];
    studentDbId?: string;
    studentId?: string;
    authProvider?: string;
  }
}
